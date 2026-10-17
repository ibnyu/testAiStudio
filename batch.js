// Unified batch pipeline: clipboard URLs -> yt-dlp download -> Drive archive
// -> AI Studio notes. One command, no intermediate Drive re-download.
//
// Usage:
//   bun batch.js [account] [--file urls.txt] [--dry-run] [--limit N]
//                [--gen-timeout MIN] [--minimize|--tile|--show|--headless]
//                [--no-archive] [--no-reuse] [--keep-local] [--remote-path Classes]
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
//
// Signed links: Apars m3u8 URLs carry a short-lived exp/sig (~2h). Each signed
// manifest is fetched up front and downloaded from the saved local playlist
// (its segments are unsigned), so a long queue can't outlive the signature;
// links already past exp are skipped with a warning instead of 403-spamming.
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  resolveAccount,
  assertBrowserProfile,
  assertRcloneRemote,
  ensureCleanWorkDir,
} from "./lib/account.js";
import {
  readSystemInstructions,
  uploadAndLink,
  remoteLink,
  listArchivedMedia,
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
  iframeCmd,
  subjectForUrl,
  isYoutube,
  urlExpiry,
  IFRAME_USER_AGENT,
} from "./lib/batchdl.js";
import { resolveSlides, slidesRoot } from "./lib/slides.js";

/**
 * Fetch a signed Apars m3u8 manifest and save it locally. The manifest URL is
 * time-limited, but the segment URLs it lists are unsigned, so a locally saved
 * playlist can be downloaded at any time. Returns the local path on success, or
 * null to fall back to the remote URL (master playlists whose child variants may
 * themselves be signed are left remote on purpose).
 */
async function prefetchManifest(url, destPath) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": IFRAME_USER_AGENT } });
    if (!res.ok) {
      console.log(`[${acct.account}] playlist fetch HTTP ${res.status} (using remote URL)`);
      return null;
    }
    const body = await res.text();
    if (!body.startsWith("#EXTM3U") || body.includes("#EXT-X-STREAM-INF")) {
      console.log(`[${acct.account}] playlist is a master/not-m3u8 (using remote URL)`);
      return null;
    }
    await Bun.write(destPath, body);
    return destPath;
  } catch (e) {
    console.log(`[${acct.account}] playlist fetch failed: ${e.message} (using remote URL)`);
    return null;
  }
}

const rawArgs = process.argv.slice(2);
let accountArg = null;
let urlsFile = null;
let dryRun = false;
let limit = null;
let genTimeoutMs = 30 * 60 * 1000;
let windowMode = "minimize";
let notion = true;
let archive = true;
let reuse = true;
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
  else if (a === "--no-reuse") reuse = false;
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

const meta = new Map(items.filter((it) => it.name).map((it) => [it.url, it]));
const downloadRoot = join(acct.workDir, "downloads");
const remoteDirFor = (subject) =>
  archive ? (bySubject ? `${archiveFolder}/${subject}` : archiveFolder) : "uploads/";
const subjectFor = (url) => (isYoutube(url) ? "YouTube" : subjectForUrl(url));

// --- reuse already-archived lectures (skip re-download) --------------------
// For each named item, look for an existing <name>.<media-ext> in the archive
// folder. When found, skip yt-dlp and just re-link the Drive copy. Only useful
// with archiving on (otherwise the temp remote copies were deleted).
const reuseByUrl = new Map();
if (reuse && archive) {
  const listings = new Map(); // remotePath -> Map(stem -> dest)
  for (const it of items) {
    if (!it.name) continue;
    const dir = remoteDirFor(subjectFor(it.url));
    if (!listings.has(dir)) listings.set(dir, listArchivedMedia(acct, dir));
    const dest = listings.get(dir).get(it.name);
    if (dest) reuseByUrl.set(it.url, dest);
  }
}

const urls = items.map((it) => it.url);
const nowSecs = Math.floor(Date.now() / 1000);
// Signed Apars links already past their `exp` are dead (the CDN 403s
// regardless of cookies/headers), so skip them with a clear message rather
// than let yt-dlp dump a 403 for each.
const expiredUrls = new Set(
  items
    .filter((it) => {
      const e = urlExpiry(it.url);
      return e !== null && e - nowSecs <= 0;
    })
    .map((it) => it.url),
);
const plans = planCommands(
  urls.filter((u) => !reuseByUrl.has(u) && !expiredUrls.has(u)),
  downloadRoot,
  meta,
);

// Signed Apars links die within minutes; download them before the long-lived
// YouTube work so they are fetched while their `exp` is still valid. This does
// NOT change processing order (notes are still produced in clipboard order).
plans.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

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
  if (reuseByUrl.has(it.url)) tag += "  (reuse: already archived)";
  const exp = urlExpiry(it.url);
  if (exp) {
    const left = exp - nowSecs;
    tag += expiredUrls.has(it.url)
      ? "  ! LINK EXPIRED (skipped)"
      : `  (link expires in ${Math.round(left / 60)}m)`;
  }
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
if (reuse && archive) {
  console.log(
    `[${acct.account}] reuse:     ${reuseByUrl.size} already archived (download skipped)`,
  );
}
const expiredCount = expiredUrls.size;
if (expiredCount) {
  console.log(
    `[${acct.account}] WARNING:  ${expiredCount} signed link(s) already expired and will be skipped — re-copy them from the site just before running.`,
  );
}
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

// --- pre-fetch signed Apars manifests --------------------------------------
// Grab each time-limited m3u8 playlist now, while its signature is valid, and
// rewrite the plan to download from the saved local copy. The segments are
// unsigned, so this makes the download immune to the manifest's expiry even if
// the queue is long — and it runs before any YouTube work.
const m3u8Plans = plans.filter((p) => p.m3u8 && p.name && p.template);
if (m3u8Plans.length) {
  const plDir = join(acct.workDir, "playlists");
  mkdirSync(plDir, { recursive: true });
  let saved = 0;
  for (const [i, plan] of m3u8Plans.entries()) {
    const dest = resolve(join(plDir, `p${String(i).padStart(2, "0")}.m3u8`));
    if (await prefetchManifest(plan.urls[0], dest)) {
      plan.cmd = iframeCmd([`file://${dest}`], plan.dir, plan.template, { fileUrls: true });
      saved++;
    }
  }
  console.log(`[${acct.account}] pre-fetched ${saved}/${m3u8Plans.length} signed playlist(s)`);
}

const downloaded = [];
for (const plan of plans) {
  console.log(`\n[${acct.account}] --- download [${plan.label}] -> ${plan.dir}/ ---`);
  const { code, paths } = await runPlan(plan);
  if (code !== 0) {
    console.log(`[${acct.account}] warning: yt-dlp exited ${code} for [${plan.label}]`);
  }
  console.log(`[${acct.account}] [${plan.label}] produced ${paths.length} file(s)`);
  for (const file of paths) {
    downloaded.push({ file, subject: plan.subject, name: plan.name, clip: plan.clip, index: plan.index });
  }
}

// Build the processing list in clipboard order: reused items carry a remote
// dest instead of a local file; unnamed items follow from the download pool
// (matching the original plan ordering).
const downloadedByName = new Map();
for (const d of downloaded) if (d.name) downloadedByName.set(d.name, d);
const work = [];
for (const it of items) {
  if (!it.name) continue;
  const dest = reuseByUrl.get(it.url);
  if (dest) {
    work.push({ name: it.name, subject: subjectFor(it.url), clip: it.clip, index: it.index, dest });
  } else {
    const d = downloadedByName.get(it.name);
    if (d) work.push(d);
    else if (expiredUrls.has(it.url)) {
      console.log(
        `[${acct.account}] skipping "${it.name}": signed link expired — re-copy it from the site and re-run.`,
      );
    } else {
      console.log(`[${acct.account}] warning: no media produced for "${it.name}" — skipping.`);
    }
  }
}
for (const d of downloaded) if (!d.name) work.push(d);

if (!work.length) {
  console.log(`[${acct.account}] No media files to process.`);
  process.exit(0);
}

// --- process each file -----------------------------------------------------
let ok = 0;
let failed = 0;
for (let i = 0; i < work.length; i++) {
  const { file, subject, name, clip, index, dest } = work[i];
  const noteBase = name || basename(file);
  console.log(
    `\n[${acct.account}] ===== note ${i + 1}/${work.length}: ${noteBase} [${subject}] =====`,
  );
  try {
    const remotePath = remoteDirFor(subject);
    const publicUrls = [];
    const cleanup = [];
    if (dest) {
      console.log(`[${acct.account}] Reusing archived copy: ${dest}`);
      const publicUrl = remoteLink(acct, dest);
      console.log(`[${acct.account}] Public link: ${publicUrl}`);
      publicUrls.push(publicUrl);
    } else {
      const up = uploadAndLink(acct, file, remotePath);
      publicUrls.push(up.publicUrl);
      cleanup.push(up.dest);
    }

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
    if (!keepLocal && file) {
      unlinkSync(file);
      console.log(`[${acct.account}] Removed local download: ${file}`);
    }
    if (!archive) for (const d of cleanup) removeRemote(acct, d);
    ok++;
  } catch (e) {
    failed++;
    console.log(
      `[${acct.account}] ERROR on ${noteBase}: ${e.message} — keeping local file for retry.`,
    );
  }
}

console.log(`\n[${acct.account}] done: ${ok} note(s) generated, ${failed} failed.`);
if (failed && !keepLocal) {
  console.log(`[${acct.account}] Failed inputs were kept under ${downloadRoot}/`);
}
process.exit(failed ? 1 : 0);
