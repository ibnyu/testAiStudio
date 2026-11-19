// Locate a chapter's lecture-slide PDFs so they can be attached alongside the
// lecture audio. Layout on disk is not fully uniform, so folder levels are
// matched alias-aware (Physics/Phy, Paper 1/P1, Chapter 4/Ch4) and the lecture
// PDFs are taken in natural-sorted order from the chapter's Slides/Notes folder
// (falling back to the chapter folder itself). Only *.pdf files are slides.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_SLIDES_ROOT =
  "/run/media/ibny/710aeb6b-0543-4125-a054-f1f3a53a0f24/HSC/pdf";

export function slidesRoot() {
  return process.env.SLIDES_ROOT || DEFAULT_SLIDES_ROOT;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, "");

// subject alias groups (lowercased). HM == Higher Math == Maths.
const SUBJECT_GROUPS = [
  ["phy", "physics"],
  ["chem", "chemistry"],
  ["bio", "biology"],
  ["math", "maths", "mathematics", "hm"],
  ["ict"],
];

function subjectMatches(token, name) {
  const t = norm(token);
  const n = norm(name);
  for (const group of SUBJECT_GROUPS) {
    if (group.includes(t) && group.includes(n)) return true;
  }
  return t === n;
}

const paperNum = (name) => {
  const m = norm(name).match(/^(?:p|paper)0*(\d+)$/);
  return m ? Number(m[1]) : null;
};
const chapterNum = (name) => {
  const m = norm(name).match(/^(?:ch|chapter)0*(\d+)$/);
  return m ? Number(m[1]) : null;
};

/**
 * Parse a name clip "Subject Instructor Paper Chapter" into its parts. Tokens
 * are classified by pattern (P2/Paper 2, Ch4/Chapter 4), so the instructor may
 * be multi-token and paper/chapter are optional.
 */
export function parseClip(clip) {
  const tokens = String(clip).trim().split(/\s+/);
  const paperIdx = tokens.findIndex((t) => paperNum(t) != null);
  const chapterIdx = tokens.findIndex((t) => chapterNum(t) != null);
  const subject = tokens[0] || null;
  let instructorEnd = tokens.length;
  if (paperIdx > 0) instructorEnd = paperIdx;
  else if (chapterIdx > 0) instructorEnd = chapterIdx;
  const instructor = tokens.slice(1, instructorEnd).join(" ").trim() || null;
  return {
    subject,
    instructor,
    paper: paperIdx > 0 ? paperNum(tokens[paperIdx]) : null,
    chapter: chapterIdx > 0 ? chapterNum(tokens[chapterIdx]) : null,
  };
}

// Match the clip parts against one directory's path components (in order).
// `requireInstructor` / `requirePaper` force those levels to be present.
function matchPath(names, parsed, { requireInstructor, requirePaper }) {
  let i = 0;
  while (i < names.length && !subjectMatches(parsed.subject, names[i])) i++;
  if (i >= names.length) return null;
  const si = i;
  let matched = 1;
  i++;

  let pi = -1;
  if (parsed.paper != null) {
    for (let j = i; j < names.length; j++) {
      if (paperNum(names[j]) === parsed.paper) {
        pi = j;
        break;
      }
    }
    if (pi < 0 && requirePaper) return null;
  }

  const afterPaper = pi >= 0 ? pi + 1 : i;
  let ci = -1;
  if (parsed.chapter != null) {
    for (let j = afterPaper; j < names.length; j++) {
      if (chapterNum(names[j]) === parsed.chapter) {
        ci = j;
        break;
      }
    }
    if (ci < 0) return null;
  }

  // Instructor sits between the subject and the paper/chapter.
  const regionEnd = pi >= 0 ? pi : ci >= 0 ? ci : names.length;
  const region = names.slice(si + 1, regionEnd);
  if (parsed.instructor != null) {
    const hit = region.findIndex((n) => norm(n) === norm(parsed.instructor));
    if (hit >= 0) matched++;
    else if (requireInstructor) return null;
    else if (region.some((n) => chapterNum(n) == null && paperNum(n) == null)) {
      // an instructor-like level exists but does not match the clip
      return null;
    }
  }

  // A paper/chapter level that exists but does not match this clip is a miss.
  if (parsed.paper != null && pi < 0 && names.some((n) => paperNum(n) != null)) return null;

  if (pi >= 0) matched++;
  if (ci >= 0) matched++;
  return { matched };
}

function relativeNames(root, dir) {
  return dir.slice(root.length + 1).split("/").filter(Boolean);
}

function listDirs(root, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        const p = join(dir, e.name);
        out.push(p);
        walk(p, depth + 1);
      }
    }
  };
  walk(root, 1);
  return out;
}

const SLIDE_DIR_NAMES = new Set(["slides", "slide", "notes", "note"]);

function pdfsIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.pdf$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => collator.compare(a, b));
}

/** From a chapter dir, prefer a Slides/Notes child, else the dir's own PDFs. */
function findSlidesDir(chapterDir, depth = 0) {
  if (depth > 2) return null;
  let entries;
  try {
    entries = readdirSync(chapterDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const named = subdirs
    .filter((e) => SLIDE_DIR_NAMES.has(norm(e.name)))
    .sort((a, b) => (norm(a.name) === "slides" ? -1 : 0) - (norm(b.name) === "slides" ? -1 : 0));
  for (const e of named) {
    const d = join(chapterDir, e.name);
    if (pdfsIn(d).length) return d;
  }
  const here = pdfsIn(chapterDir);
  if (here.length) return chapterDir;
  for (const e of subdirs) {
    const found = findSlidesDir(join(chapterDir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function pickBest(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!best) best = c;
    else if (c.score.matched > best.score.matched) best = c;
    else if (c.score.matched === best.score.matched && c.names.length < best.names.length) best = c;
    else if (
      c.score.matched === best.score.matched &&
      c.names.length === best.names.length &&
      c.dir < best.dir
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Resolve a name clip to its chapter folder + ordered slide PDFs.
 * Returns { dir, chapterDir, files: [absolute paths] } or null if not found.
 * Tries strictest matching first (instructor + paper required) before relaxing,
 * so a clip for "Phy Mashrur P2 Ch6" never silently resolves to another teacher.
 */
export function resolveSlides(clip, root = slidesRoot()) {
  if (!root || !existsSync(root)) return null;
  const parsed = parseClip(clip);
  if (!parsed.subject) return null;

  const dirs = listDirs(root).map((dir) => ({ dir, names: relativeNames(root, dir) }));
  const attempts = [
    { requireInstructor: parsed.instructor != null, requirePaper: parsed.paper != null },
    { requireInstructor: false, requirePaper: parsed.paper != null },
    { requireInstructor: false, requirePaper: false },
  ];

  for (const opts of attempts) {
    const candidates = [];
    for (const d of dirs) {
      const score = matchPath(d.names, parsed, opts);
      if (score) candidates.push({ ...d, score });
    }
    const best = pickBest(candidates);
    if (best) {
      const slidesDir = findSlidesDir(best.dir);
      if (!slidesDir) return { dir: null, chapterDir: best.dir, files: [] };
      return {
        dir: slidesDir,
        chapterDir: best.dir,
        files: pdfsIn(slidesDir).map((f) => join(slidesDir, f)),
      };
    }
  }
  return null;
}

/** The slide PDF for a given 1-based lecture index, or null. */
export function slideForIndex(clip, index, root = slidesRoot()) {
  const resolution = resolveSlides(clip, root);
  const pdf = resolution && resolution.files.length ? resolution.files[index - 1] || null : null;
  return { resolution, pdf };
}

// ---------------------------------------------------------- pdf splitting ----
export function pdfPageCount(file) {
  const proc = Bun.spawnSync(["pdfinfo", file], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return null;
  const m = proc.stdout.toString().match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

function pdfBytes(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Decide how to attach a slide PDF to N audio chunks.
 *
 * - A PDF that is small enough (<= maxPages, <= maxMB) stays one file and is
 *   attached to every audio chunk (the model needs the whole deck for context).
 * - A larger PDF is split into N equal page ranges, one per audio chunk.
 * - With a single audio chunk we never split (splitting would only hide pages).
 *
 * Returns [{ index, count, path, pages:[from,to], temp }] length = audioParts.
 */
export function planSlideParts(
  file,
  { audioParts = 1, maxPages = 40, maxMB = 12, outDir = null, log = () => {} } = {},
) {
  if (!file || !existsSync(file)) return [];
  const pages = pdfPageCount(file) || 1;
  const bytes = pdfBytes(file);
  const tooBig = pages > maxPages || bytes > maxMB * 1024 * 1024;
  if (audioParts <= 1 || !tooBig) {
    return [{ index: 1, count: 1, path: file, pages: [1, pages], temp: false }];
  }
  const count = Math.min(audioParts, pages);
  const dir = outDir || join(file, "..", ".slide-parts");
  if (!outDir) {
    log(`warning: no output dir for slide split; attaching the whole PDF to each part`);
    return Array.from({ length: audioParts }, (_, i) => ({
      index: i + 1, count: 1, path: file, pages: [1, pages], temp: false,
    }));
  }
  const per = pages / count;
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * per) + 1;
    const to = i === count - 1 ? pages : Math.floor((i + 1) * per);
    const dest = join(dir, `part-${String(i + 1).padStart(2, "0")}.pdf`);
    if (!(existsSync(dest) && statSync(dest).size > 0)) {
      log(`splitting slides pages ${from}-${to}/${pages} ...`);
      splitPdfRange(file, from, to, dest);
    }
    out.push({ index: i + 1, count, path: dest, pages: [from, to], temp: true });
  }
  // If there are more audio chunks than pages, repeat the last slide part.
  while (out.length < audioParts) out.push({ ...out[out.length - 1], index: out.length + 1 });
  return out;
}

/** Extract pages [from,to] of `file` into `dest` using pdfseparate + pdfunite. */
export function splitPdfRange(file, from, to, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmpDir = mkdtempSync(join(tmpdir(), "zaknotes-pdf-"));
  try {
    const pattern = join(tmpDir, "p-%d.pdf");
    const sep = Bun.spawnSync(
      ["pdfseparate", "-f", String(from), "-l", String(to), file, pattern],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (sep.exitCode !== 0) {
      throw new Error(`pdfseparate failed: ${sep.stderr.toString().trim().slice(0, 300)}`);
    }
    const pages = readdirSync(tmpDir)
      .filter((f) => f.endsWith(".pdf"))
      .sort((a, b) => collator.compare(a, b))
      .map((f) => join(tmpDir, f));
    if (!pages.length) throw new Error(`pdfseparate produced no pages for ${file}`);
    const unite = Bun.spawnSync(["pdfunite", ...pages, dest], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (unite.exitCode !== 0) {
      throw new Error(`pdfunite failed: ${unite.stderr.toString().trim().slice(0, 300)}`);
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  return dest;
}
