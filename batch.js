// Unified batch pipeline: clipboard URLs -> yt-dlp download -> Drive archive
// -> AI Studio notes. One command, no intermediate Drive re-download.
//
// Usage:
//   bun batch.js [account] [--file urls.txt] [--dry-run] [--limit N]
//                [--gen-timeout MIN] [--minimize|--tile|--show|--headless]
//                [--no-archive] [--keep-local] [--remote-path Classes]
//                [--notes-dir ./notes] [--no-slides] [--slides-root DIR]
//
// Defaults: account=ibny, source=clipboard history, window=minimize,
//           archive=on (uploads under Classes/ and keeps it, matching the
//           original batch-dl flat layout), local audio deleted after a note.
//
// Naming: copy a name clip (Subject Instructor Paper Chapter, e.g.
// "Phy Udv P2 Ch4") just before a run of URLs. Each URL in the run is named
// "<clip> 01", "<clip> 02", ... (the number is space-joined so it never merges
// with the chapter). A new clip starts the next run at 01. A trailing number in
// the clip (e.g. "Phy Udv P2 Ch4 04") sets the starting index instead of 01.
// The name becomes the archived filename, the note filename, and the Notion
// page title (the note body keeps the model's own heading). URLs copied without
// a clip keep the old behaviour.
//
// Slides: each named lecture also gets its slide PDF attached right after the
// audio, which markedly improves note quality. The clip's chapter is resolved
// under --slides-root (default the HSC/pdf drive), then the NN-th PDF (PDFs
// only, natural order) from the chapter's Slides/Notes folder is used. The PDF
// is uploaded to Drive as "<name>.pdf" next to the audio and attached too.
import { existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import {
  resolveAccount,
  assertBrowserProfile,
  assertRcloneRemote,
  ensureCleanWorkDir,
} from "./lib/account.js";
import {
  readSystemInstructions,
  uploadAndLink,
  removeRemote,
  generateNoteFromUrl,
  pushNoteIfConfigured,
} from "./lib/pipeline.js";
import {
  readClipboardGroups,
  parseGroups,
  expandGroups,
  planCommands,
  runPlan,
  subjectForUrl,
  isYoutube,
} from "./lib/batchdl.js";
import { resolveSlides, slidesRoot } from "./lib/slides.js";

const rawArgs = process.argv.slice(2);
let accountArg = null;
let urlsFile = null;
let dryRun = false;
let limit = null;
let genTimeoutMs = 30 * 60 * 1000;
let windowMode = "minimize";
let notion = true;
let archive = true;
let keepLocal = false;
let archiveFolder = "Classes";
let bySubject = false;
let notesDir = "./notes";
let slides = true;
let slidesRootPath = null;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--file") urlsFile = rawArgs[++i];
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--limit") {
    limit = Number(rawArgs[++i]);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit needs a positive integer");
  } else if (a === "--gen-timeout") {
    const mins = Number(rawArgs[++i]);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error("--gen-timeout <minutes> (positive)");
    genTimeoutMs = mins * 60 * 1000;
  } else if (a === "--headless") windowMode = "headless";
  else if (a === "--minimize") windowMode = "minimize";
  else if (a === "--tile") windowMode = "tile";
  else if (a === "--show") windowMode = "show";
  else if (a === "--no-archive") archive = false;
  else if (a === "--no-notion") notion = false;
  else if (a === "--no-slides") slides = false;
  else if (a === "--slides-root") slidesRootPath = rawArgs[++i];
  else if (a === "--by-subject") bySubject = true;
  else if (a === "--keep-local") keepLocal = true;
  else if (a === "--remote-path") archiveFolder = rawArgs[++i];
  else if (a === "--notes-dir") notesDir = rawArgs[++i];
  else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
  else if (!accountArg) accountArg = a;
  else throw new Error(`Unexpected argument: ${a}`);
}
accountArg = accountArg || "ibny";
slidesRootPath = slidesRootPath || slidesRoot();

const acct = resolveAccount(accountArg);
assertBrowserProfile(acct.userDataDir);
assertRcloneRemote(acct.rcloneRemote, acct.rcloneConfig);

// --- gather URLs and names ------------------------------------------------
// A name clip (e.g. "Phy Udv P2 Ch4") copied just before a run of URLs names
// that whole run; the lecture number is generated 01..N and joined by a space.
let items;
if (urlsFile) {
  if (!existsSync(urlsFile)) throw new Error(`URL file not found: ${urlsFile}`);
  const lines = (await Bun.file(urlsFile).text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  items = expandGroups(parseGroups(lines));
} else {
  items = expandGroups(readClipboardGroups());
}
if (limit) items = items.slice(0, limit);
if (!items.length) throw new Error("no URLs to process");

const urls = items.map((it) => it.url);
const meta = new Map(items.filter((it) => it.name).map((it) => [it.url, it]));
const downloadRoot = join(acct.workDir, "downloads");
const plans = planCommands(urls, downloadRoot, meta);

// --- resolve slide PDFs (position in the chapter folder, PDFs only) --------
// The clip's lecture number picks the NN-th PDF, so the pairing is verifiable
// up front in the report below.
const slideMap = new Map();
if (slides) {
  for (const it of items) {
    if (!it.clip || slideMap.has(it.clip)) continue;
    slideMap.set(it.clip, resolveSlides(it.clip, slidesRootPath));
  }
}
const pdfForItem = (it) => {
  if (!slides || !it.clip) return null;
  const res = slideMap.get(it.clip);
  if (!res || !res.files.length) return null;
  return res.files[it.index - 1] || null;
};

// --- describe --------------------------------------------------------------
const modes = [...new Set(urls.map((u) => (isYoutube(u) ? "youtube" : "apar")))];
console.log(`[${acct.account}] mode:      ${modes.join("+")}`);
console.log(`[${acct.account}] batch:     ${urls.length} URL(s), in copy order:`);
items.forEach((it, i) => {
  let tag = it.name ? ` -> ${it.name}` : ` [${subjectForUrl(it.url)}]`;
  if (slides) {
    if (!it.clip) tag += "  (no clip: audio only)";
    else {
      const pdf = pdfForItem(it);
      tag += pdf ? `  + slide ${basename(pdf)}` : "  ! NO SLIDE";
    }
  }
  console.log(`  ${String(i + 1).padStart(2)}. ${it.url}${tag}`);
});
if (slides) {
  console.log(`[${acct.account}] slides:    ${slidesRootPath}`);
  for (const [clip, res] of slideMap) {
    const rel = res && res.dir ? res.dir.slice(slidesRootPath.length + 1) : null;
    const n = res ? res.files.length : 0;
    const needed = items.filter((it) => it.clip === clip).length;
    const warn = !res || !n ? "  (NOT FOUND)" : n < needed ? `  (only ${n} for ${needed} lectures)` : "";
    console.log(`   "${clip}" -> ${rel ?? "(none)"} [${n} pdf]${warn}`);
  }
}
console.log(`[${acct.account}] download:  ${downloadRoot}/`);
console.log(
  `[${acct.account}] archive:   ${archive ? `${acct.rcloneRemote}${archiveFolder}/${bySubject ? "<Subject>/" : ""} (kept)` : "off (temp uploads/, deleted)"}`,
);
console.log(`[${acct.account}] notes:     ${notesDir}/`);
console.log(`[${acct.account}] window:    ${windowMode}`);

if (dryRun) {
  console.log("\ncommands:");
  for (const p of plans) console.log(`  [${p.label}] -> ${p.dir}/\n  ${p.cmd.join(" \\\n  ")}`);
  console.log("\n(dry run — nothing downloaded or processed)");
  process.exit(0);
}

// --- download --------------------------------------------------------------
const sysText = await readSystemInstructions();
const dirState = ensureCleanWorkDir(acct.workDir);
console.log(
  `[${acct.account}] Work dir ${acct.workDir}/ (${dirState.created ? "created" : "cleaned"}).`,
);

const files = [];
for (const plan of plans) {
  console.log(`\n[${acct.account}] --- download [${plan.label}] -> ${plan.dir}/ ---`);
  const { code, paths } = await runPlan(plan);
  if (code !== 0) {
    console.log(`[${acct.account}] warning: yt-dlp exited ${code} for [${plan.label}]`);
  }
  console.log(`[${acct.account}] [${plan.label}] produced ${paths.length} file(s)`);
  for (const file of paths) {
    files.push({ file, subject: plan.subject, name: plan.name, clip: plan.clip, index: plan.index });
  }
}

if (!files.length) {
  console.log(`[${acct.account}] No media files produced; nothing to process.`);
  process.exit(0);
}

// --- process each file -----------------------------------------------------
let ok = 0;
let failed = 0;
for (let i = 0; i < files.length; i++) {
  const { file, subject, name, clip, index } = files[i];
  const noteBase = name || basename(file);
  console.log(
    `\n[${acct.account}] ===== note ${i + 1}/${files.length}: ${noteBase} [${subject}] =====`,
  );
  try {
    const remotePath = archive
      ? bySubject
        ? `${archiveFolder}/${subject}`
        : archiveFolder
      : "uploads/";
    const { dest, publicUrl } = uploadAndLink(acct, file, remotePath);
    const publicUrls = [publicUrl];
    const cleanup = [dest];

    // Upload the matching slide PDF under the same base name, right after the
    // audio, then attach both (audio first) so the model sees slides + audio.
    let pdf = null;
    if (slides && clip && index) pdf = pdfForItem({ clip, index });
    if (slides && clip && index && !pdf) {
      console.log(`[${acct.account}] warning: no slide PDF for "${noteBase}" (audio only).`);
    }
    if (pdf) {
      const up = uploadAndLink(acct, pdf, remotePath, `${noteBase}.pdf`);
      publicUrls.push(up.publicUrl);
      cleanup.push(up.dest);
      console.log(`[${acct.account}] Slide: ${basename(pdf)} -> ${noteBase}.pdf`);
    }

    const { notePath } = await generateNoteFromUrl({
      acct,
      publicUrls,
      noteBaseName: noteBase,
      sysText,
      windowMode,
      genTimeoutMs,
      notesDir,
    });
    await pushNoteIfConfigured({
      notePath,
      title: basename(notePath, ".md"),
      enabled: notion,
    });
    if (!keepLocal) {
      unlinkSync(file);
      console.log(`[${acct.account}] Removed local download: ${file}`);
    }
    if (!archive) for (const d of cleanup) removeRemote(acct, d);
    ok++;
  } catch (e) {
    failed++;
    console.log(
      `[${acct.account}] ERROR on ${basename(file)}: ${e.message} — keeping local file for retry.`,
    );
  }
}

console.log(`\n[${acct.account}] done: ${ok} note(s) generated, ${failed} failed.`);
if (failed && !keepLocal) {
  console.log(`[${acct.account}] Failed inputs were kept under ${downloadRoot}/`);
}
process.exit(failed ? 1 : 0);
