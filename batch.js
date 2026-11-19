// Zaknotes v2: clipboard URLs -> yt-dlp download -> Drive archive -> AI Studio
// notes. One command, no intermediate Drive re-download.
//
// Full guide: USAGE.md (also printed by `--help`). Flags summary:
// Usage:
//   bun batch.js [account] [--file urls.txt | --media-file list.tsv]
//                [--dry-run] [--limit N] [--gen-timeout MIN]
//                [--chunk-minutes MIN | --no-chunk] [--min-note-chars N]
//                [--minimize|--tile|--show|--headless]
//                [--no-archive] [--no-reuse] [--keep-local] [--remote-path Classes]
//                [--notes-dir ./notes] [--no-slides] [--slides-root DIR]
//                [--model SLUG|latest-flash] [--resume|--no-resume] [--force]
//                [--clean-audio] [--backup-account NAME] [--no-backup]
//
// Settings default to ./config.json (see `bun config.js`); every flag below
// overrides the matching config value for this run.
//
// Defaults: account=ibny, source=clipboard history, window=minimize,
//           archive=on (uploads under Classes/ and keeps it, matching the
//           original batch-dl flat layout), local audio deleted after a note,
//           duration chunking on at 120 min/part (150 min ceiling),
//           model=gemini-4-hydrogen with a fallback chain.
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
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backoffDelay } from "./lib/retry.js";
import {
  resolveAccount,
  assertBrowserProfile,
  assertRcloneRemote,
  ensureCleanWorkDir,
  rcloneArgs,
  reapOrphanBrowsers,
} from "./lib/account.js";
import {
  readSystemInstructions,
  uploadAndLink,
  remoteLink,
  listArchivedMedia,
  removeRemote,
  generateMarkdown,
  minimizeWindow,
  partInstruction,
  pushNoteIfConfigured,
  existingNotionTitles,
} from "./lib/pipeline.js";
import {
  readClipboardGroups,
  parseGroups,
  expandGroups,
  planCommands,
  findDownloaded,
  downloadArtifacts,
  runPlan,
  iframeCmd,
  subjectForUrl,
  isYoutube,
  urlExpiry,
  absolutizeManifest,
  splitNameClip,
  IFRAME_USER_AGENT,
} from "./lib/batchdl.js";
import { resolveSlides, planSlideParts, slidesRoot } from "./lib/slides.js";
import { loadConfig } from "./lib/config.js";
import { appendHistory, bumpCounters, stateDir } from "./lib/state.js";
import { cleanAudio, ffmpegAvailable } from "./lib/audio.js";
import { LATEST_FLASH, modelChain } from "./lib/models.js";
import { probeDuration, planChunks, splitMedia, PartCache } from "./lib/chunk.js";
import { assertValidNote, scrubNoteArtifacts, inspectNote } from "./lib/validate.js";
import { sanitizeMath } from "./lib/sanitize.js";
import { resolveGenerationAccounts, generateWithFallback } from "./lib/fallback.js";
import { acquireLock } from "./lib/lock.js";
import { installSignalHandlers, launchNoteBrowser, closeNoteBrowser } from "./lib/browser.js";
import { runPool } from "./lib/pool.js";
import { printUsage } from "./lib/usage.js";

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
    await Bun.write(destPath, absolutizeManifest(body, url));
    return destPath;
  } catch (e) {
    console.log(`[${acct.account}] playlist fetch failed: ${e.message} (using remote URL)`);
    return null;
  }
}

const cfg = loadConfig();

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printUsage();
  process.exit(0);
}
let accountArg = null;
let urlsFile = null;
let mediaFile = null;
let dryRun = false;
let limit = null;
let genTimeoutMs = (cfg.genTimeoutMin ?? 10) * 60 * 1000;
let windowMode = cfg.windowMode || "minimize";
let notion = cfg.notion?.enabled ?? true;
let archive = cfg.archive?.enabled ?? true;
let reuse = cfg.reuse ?? true;
let keepLocal = false;
let archiveFolder = cfg.archive?.folder || "Classes";
let bySubject = cfg.archive?.bySubject ?? false;
let notesDir = "./notes";
let slides = cfg.slides?.enabled ?? true;
let slidesRootPath = cfg.slides?.root || null;
let model = cfg.model || LATEST_FLASH;
let resume = cfg.resume ?? true;
let force = false;
let cleanAudioEnabled = cfg.audioClean?.enabled ?? false;
let backupAccount = cfg.backupAccount || null;
let chunking = { ...(cfg.chunking || {}) };
let minNoteChars = cfg.minNoteChars ?? 400;
let jobsWanted = cfg.jobs ?? 1;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--file") urlsFile = rawArgs[++i];
  else if (a === "--media-file") mediaFile = rawArgs[++i];
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
  else if (a === "--model") model = rawArgs[++i];
  else if (a === "--resume") resume = true;
  else if (a === "--no-resume") resume = false;
  else if (a === "--force") force = true;
  else if (a === "--clean-audio") cleanAudioEnabled = true;
  else if (a === "--no-clean-audio") cleanAudioEnabled = false;
  else if (a === "--backup-account") backupAccount = rawArgs[++i];
  else if (a === "--no-backup") backupAccount = null;
  else if (a === "--jobs") {
    jobsWanted = Number(rawArgs[++i]);
    if (!Number.isInteger(jobsWanted) || jobsWanted < 1) {
      throw new Error("--jobs needs a positive integer (1 = sequential)");
    }
  }
  else if (a === "--no-chunk") chunking.enabled = false;
  else if (a === "--chunk") chunking.enabled = true;
  else if (a === "--chunk-minutes") {
    const mins = Number(rawArgs[++i]);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error("--chunk-minutes <minutes> (positive)");
    chunking.maxMinutes = mins;
    chunking.enabled = true;
  } else if (a === "--min-note-chars") {
    const n = Number(rawArgs[++i]);
    if (!Number.isInteger(n) || n < 0) throw new Error("--min-note-chars <integer>");
    minNoteChars = n;
  } else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
  else if (!accountArg) accountArg = a;
  else throw new Error(`Unexpected argument: ${a}`);
}
accountArg = accountArg || cfg.account || "ibny";
slidesRootPath = slidesRootPath || slidesRoot();

const acct = resolveAccount(accountArg);
assertBrowserProfile(acct.userDataDir);
assertRcloneRemote(acct.rcloneRemote, acct.rcloneConfig);

// Refuse to run if another batch for this account is already active (an
// interrupted run can otherwise keep the browser profile locked).
installSignalHandlers();
acquireLock(join(stateDir(cfg), `${acct.account}.lock`));

// A crash or a desktop freeze can leave Chromium processes reparented to PID 1,
// still holding gigabytes. Clear ours before a new run starts; processes owned
// by a live run have a real parent and are never touched.
const reapedOrphans = reapOrphanBrowsers();
if (reapedOrphans.length) {
  console.log(`[${acct.account}] reaped ${reapedOrphans.length} orphaned browser process(es).`);
}

// Generation accounts: primary + optional backups. Backups need only a browser
// profile; downloads/uploads/archive always stay on the primary account.
const backupNames = [backupAccount, ...(cfg.accounts?.backups || [])].filter(Boolean);
let genAccounts;
let accountStrategy = cfg.accounts?.strategy || "on-failure";
try {
  const resolved = resolveGenerationAccounts({
    primaryName: acct.account,
    backups: backupNames,
    strategy: accountStrategy,
    log: (m) => console.log(`[${acct.account}] ${m}`),
  });
  genAccounts = resolved.accounts;
  accountStrategy = resolved.strategy;
} catch (e) {
  console.log(`[${acct.account}] account fallback disabled: ${e.message}`);
  genAccounts = [{ ...acct, primary: true, backup: false }];
}
const backupAcct = genAccounts.find((a) => a.backup) || null;
const models = modelChain(model, cfg.modelFallbacks);
const chunkEnabled = chunking.enabled !== false;
// Tabs generating in parallel. Each lane starts on a different model, because
// Google's rate limit is per model — spreading the lanes is what keeps 2-4
// tabs faster than one (they all share the account, like manual tabs).
const jobs = Math.max(1, Math.min(4, Math.floor(jobsWanted) || 1));

// --- gather URLs and names ------------------------------------------------
// A name clip (e.g. "Phy Udv P2 Ch4") copied just before a run of URLs names
// that whole run; the lecture number is generated 01..N and joined by a space.
let items;
const mediaManifest = mediaFile
  ? (await Bun.file(mediaFile).text())
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((line) => {
        const [name, file, dest] = line.split("\t");
        if (!name || !file) throw new Error(`bad --media-file line: ${line}`);
        const { base, start } = splitNameClip(name.trim());
        return {
          name: name.trim(),
          url: null,
          subject: "Repair",
          clip: base,
          index: start,
          file: file.trim(),
          dest: dest && dest.trim() ? dest.trim() : undefined,
        };
      })
  : null;
if (mediaManifest) {
  items = mediaManifest;
  console.log(`[${acct.account}] media:     ${items.length} local file(s) from ${mediaFile}`);
} else if (urlsFile) {
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
const meta = new Map(items.filter((it) => it.name && it.url).map((it) => [it.url, it]));
const downloadRoot = join(acct.workDir, "downloads");
const remotePathFor = (subject) =>
  archive ? (bySubject ? `${archiveFolder}/${subject}` : archiveFolder) : "uploads/";
const subjectFor = (url) => (!url ? "Repair" : isYoutube(url) ? "YouTube" : subjectForUrl(url));

// --- reuse already-archived lectures (skip re-download) --------------------
// For each named item, look for an existing <name>.<media-ext> in the archive
// folder. When found, skip yt-dlp and just re-link the Drive copy. Only useful
// with archiving on (otherwise the temp remote copies were deleted).
const reuseByUrl = new Map();
if (reuse && archive && !mediaManifest) {
  const listings = new Map(); // remotePath -> Map(stem -> dest)
  for (const it of items) {
    if (!it.name) continue;
    const dir = remotePathFor(subjectFor(it.url));
    if (!listings.has(dir)) listings.set(dir, listArchivedMedia(acct, dir));
    const dest = listings.get(dir).get(it.name);
    if (dest) reuseByUrl.set(it.url, dest);
  }
}

const urls = items.map((it) => it.url).filter(Boolean);
const nowSecs = Math.floor(Date.now() / 1000);
// Signed Apars links already past their `exp` are dead (the CDN 403s
// regardless of cookies/headers), so skip them with a clear message rather
// than let yt-dlp dump a 403 for each.
const expiredUrls = new Set(
  items
    .filter((it) => {
      if (!it.url) return false;
      const e = urlExpiry(it.url);
      return e !== null && e - nowSecs <= 0;
    })
    .map((it) => it.url),
);
let plans = planCommands(
  urls.filter((u) => !reuseByUrl.has(u) && !expiredUrls.has(u)),
  downloadRoot,
  meta,
);

// Signed Apars links die within minutes; download them before the long-lived
// YouTube work so they are fetched while their `exp` is still valid. This does
// NOT change processing order (notes are still produced in clipboard order).
plans.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

// An earlier run may already have downloaded some media (kept in downloads/):
// reuse those files rather than fetching them again. Only named lectures can be
// matched this way; the reused file then flows through the same archive/note
// pipeline as a fresh download.
const localReused = [];
plans = plans.filter((plan) => {
  if (!reuse) return true;
  if (!plan.name) return true;
  const found = findDownloaded(plan.dir, plan.name);
  if (!found) return true;
  localReused.push({ plan, file: found });
  return false;
});
if (localReused.length) {
  console.log(
    `[${acct.account}] reuse:     ${localReused.length} already-downloaded file(s) kept from a previous run`,
  );
}
const localReuseNames = new Set(localReused.map(({ plan }) => plan.name));

// --- resume: skip lectures already noted -----------------------------------
// Resume is on by default. A lecture counts as done when its note exists
// locally or is already in Notion (matched by title). --force regenerates
// regardless; --no-resume turns the check off.
const resumeTitles =
  resume && notion ? await existingNotionTitles({ enabled: true }) : new Set();
const noteDoneReason = (name, noteFile) => {
  if (existsSync(noteFile)) {
    try {
      const text = readFileSync(noteFile, "utf8");
      const check = inspectNote(text, { minChars: minNoteChars });
      if (check.ok) return "local note";
      const codes = check.issues.filter((x) => x.severity === "error").map((x) => x.code).join(", ");
      console.log(`[${acct.account}] existing note "${name}" is invalid (${codes}) — will regenerate.`);
    } catch {
      // unreadable -> regenerate
    }
  }
  if (name && resumeTitles.has(name)) return "in Notion";
  return null;
};
if (resume) {
  console.log(
    `[${acct.account}] resume:    on (${resumeTitles.size} note title(s) in Notion) — --force regenerates, --no-resume disables`,
  );
}

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
  else if (it.name && localReuseNames.has(it.name)) tag += "  (reuse: already downloaded)";
  if (resume && !force && it.name) {
    const why = noteDoneReason(it.name, join(notesDir, it.name + ".md"));
    if (why) tag += `  (resume: ${why})`;
  }
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
console.log(`[${acct.account}] model:     ${model}${models.length > 1 ? ` (fallbacks: ${models.slice(1).join(", ")})` : ""}`);
console.log(
  `[${acct.account}] chunking:  ${chunkEnabled ? `on, ${chunking.maxMinutes ?? 120} min per part (ceiling ${chunking.ceilingMinutes ?? 150})` : "off"}`,
);
console.log(
  `[${acct.account}] audio:     ${cleanAudioEnabled ? "clean (ffmpeg loudnorm)" : "as downloaded"}`,
);
console.log(
  `[${acct.account}] accounts:  ${genAccounts.map((a) => a.account + (a.backup ? " (backup)" : "")).join(" -> ")} [${accountStrategy}]`,
);
if (backupAcct) console.log(`[${acct.account}] backup:    ${backupAcct.account} (on failure)`);

if (dryRun) {
  console.log("\ncommands:");
  for (const p of plans) console.log(`  [${p.label}] -> ${p.dir}/\n  ${p.cmd.join(" \\\n  ")}`);
  console.log("\n(dry run — nothing downloaded or processed)");
  process.exit(0);
}

// --- download --------------------------------------------------------------
const sysText = await readSystemInstructions();
const dirState = ensureCleanWorkDir(acct.workDir, { keep: ["downloads"] });
console.log(
  `[${acct.account}] Work dir ${acct.workDir}/ (${dirState.created ? "created" : "cleaned"}, downloads/ kept).`,
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
      plan.cmd = iframeCmd([pathToFileURL(dest).href], plan.dir, plan.template, { fileUrls: true });
      saved++;
    }
  }
  console.log(`[${acct.account}] pre-fetched ${saved}/${m3u8Plans.length} signed playlist(s)`);
}

const downloaded = localReused.map(({ plan, file }) => ({
  file,
  subject: plan.subject,
  name: plan.name,
  clip: plan.clip,
  index: plan.index,
}));

/**
 * Delete every artifact yt-dlp left for a named plan (final media, `.part`,
 * `.ytdl`, our `.download.inprogress` marker, and `.complete`) so the next
 * attempt downloads the file in full. This matters after Ctrl+C: the partial
 * file must never be mistaken for a finished one.
 */
function cleanPartialDownload(plan) {
  if (!plan.name) return;
  const files = downloadArtifacts(plan.dir, plan.name);
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {}
  }
}

/**
 * Run a download plan, retrying a failed yt-dlp run a couple of times so a
 * transient DNS/network blip does not drop the lecture. Apars links are fetched
 * from the saved local playlist, whose segments are unsigned, so a retry does
 * not depend on the (possibly expired) original signed URL.
 */
async function runPlanWithRetry(plan, attempts = 3) {
  let result = { code: 1, paths: [] };
  // A plan reaches this point only when no finished file was found. Anything on
  // disk is therefore a leftover from an interrupted run (or --no-reuse), so
  // clear it and download the whole file again instead of trusting a truncated
  // final file.
  if (plan.name) {
    const leftovers = downloadArtifacts(plan.dir, plan.name);
    if (leftovers.length) {
      console.log(
        `[${acct.account}] clearing ${leftovers.length} unfinished artifact(s) for "${plan.name}" — re-downloading in full.`,
      );
      cleanPartialDownload(plan);
    }
  }
  for (let a = 1; a <= attempts; a++) {
    result = await runPlan(plan);
    if (result.code === 0) return result;
    if (a < attempts) {
      console.log(
        `[${acct.account}] download [${plan.label}] failed (yt-dlp exit ${result.code}); ` +
          `retry ${a}/${attempts - 1} after clearing partials...`,
      );
      cleanPartialDownload(plan);
      await Bun.sleep(backoffDelay(a, { baseDelayMs: 5000, maxDelayMs: 30000 }));
    }
  }
  return result;
}

for (const plan of plans) {
  console.log(`\n[${acct.account}] --- download [${plan.label}] -> ${plan.dir}/ ---`);
  const { code, paths } = await runPlanWithRetry(plan);
  if (code !== 0) {
    console.log(`[${acct.account}] warning: yt-dlp exited ${code} for [${plan.label}] after retries`);
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
if (mediaManifest) {
  // Repair mode: files are already restored locally; skip URL/download logic.
  for (const it of items) work.push(it);
} else for (const it of items) {
  if (!it.name) continue;
  const dest = reuseByUrl.get(it.url);
  if (dest) {
    work.push({ name: it.name, subject: subjectFor(it.url), clip: it.clip, index: it.index, dest });
  } else {
    const d = downloadedByName.get(it.name);
    if (d) {
      work.push(d);
    } else {
      // No fresh download this run. If the media is already on disk (from a
      // previous run, or a recovered download), use it even when the signed URL
      // has since expired — otherwise a queue that outlived its links could
      // never be finished without re-copying every URL.
      const local = findDownloaded(join(downloadRoot, subjectFor(it.url)), it.name);
      if (local) {
        console.log(`[${acct.account}] using local file for "${it.name}" (${basename(local)}).`);
        work.push({
          name: it.name,
          subject: subjectFor(it.url),
          clip: it.clip,
          index: it.index,
          file: local,
        });
      } else if (expiredUrls.has(it.url)) {
        console.log(
          `[${acct.account}] skipping "${it.name}": signed link expired — re-copy it from the site and re-run.`,
        );
      } else {
        console.log(`[${acct.account}] warning: no media produced for "${it.name}" — skipping.`);
      }
    }
  }
}
for (const d of downloaded) if (!d.name) work.push(d);

if (!work.length) {
  console.log(`[${acct.account}] No media files to process.`);
  process.exit(0);
}

// --- process each file -----------------------------------------------------
const stateDirectory = stateDir(cfg);
const historyEnabled = cfg.history?.enabled ?? true;
const countersEnabled = cfg.counters?.enabled ?? true;
const record = (entry) => {
  if (historyEnabled) appendHistory(stateDirectory, entry);
};

const cleanEnabled = cleanAudioEnabled && ffmpegAvailable();
if (cleanAudioEnabled && !cleanEnabled) {
  console.log(`[${acct.account}] warning: ffmpeg not found — audio clean disabled.`);
}

const chunkCfg = {
  enabled: chunkEnabled,
  maxMinutes: chunking.maxMinutes ?? 120,
  ceilingMinutes: chunking.ceilingMinutes ?? 150,
  genTimeoutMin: chunking.genTimeoutMin ?? 20,
  retryAttempts: chunking.retryAttempts ?? 2,
  slidesMaxPages: chunking.slidesMaxPages ?? 40,
  slidesMaxMB: chunking.slidesMaxMB ?? 12,
};
const chunkGenTimeoutMs = chunkCfg.genTimeoutMin * 60 * 1000;
const PART_MIN_CHARS = 120;
const safeName = (s) => String(s || "lecture").replace(/[^\w.\- ]+/g, "_").trim() || "lecture";
const pad2 = (n) => String(n).padStart(2, "0");

/** Rehydrate an archived lecture to a local file when no local copy survived. */
async function ensureLocalFile(item, noteBase) {
  if (item.file && existsSync(item.file)) return { file: item.file, temp: false };
  if (!item.dest) throw new Error("no local media or archived copy to process");
  const ext = extname(item.dest) || ".mp3";
  const local = join(acct.workDir, "restore", safeName(noteBase) + ext);
  mkdirSync(dirname(local), { recursive: true });
  console.log(`[${acct.account}] Restoring archived media: ${item.dest} -> ${local}`);
  const proc = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "copyto", item.dest, local)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`rclone copyto restore failed: ${proc.stderr.toString().trim()}`);
  }
  return { file: local, temp: true };
}

/**
 * Upload the original media once (archive) or just mint a public link for the
 * archived copy. Returns { publicUrl, dest, cleaned }.
 */
function uploadOriginal(item, file) {
  if (item.dest) {
    console.log(`[${acct.account}] Reusing archived copy: ${item.dest}`);
    return { publicUrl: remoteLink(acct, item.dest), dest: item.dest, cleaned: null };
  }
  let upFile = file;
  let cleaned = null;
  if (cleanEnabled) {
    cleaned = cleanAudio(file, {
      target: cfg.audioClean?.loudnessTarget ?? -16,
      log: (m) => console.log(`[${acct.account}] ${m}`),
    });
    if (cleaned) {
      upFile = cleaned;
      console.log(`[${acct.account}] Cleaned audio: ${basename(cleaned)}`);
    }
  }
  const up = uploadAndLink(acct, upFile, remotePathFor(item.subject));
  return { publicUrl: up.publicUrl, dest: up.dest, cleaned };
}

/** Upload a temporary part file; always removed after the note (even in archive mode). */
function uploadTempPart(file, noteBase, label) {
  const ext = extname(file) || ".bin";
  const asName = `${label}${ext}`;
  const remoteDir = `uploads/chunks/${safeName(noteBase)}/`;
  const up = uploadAndLink(acct, file, remoteDir, asName);
  return { url: up.publicUrl, dest: up.dest };
}

/**
 * One generation attempt with account × model fallback. Uploads always use the
 * primary account; only the browser/profile changes for a backup account.
 */
async function generatePart({ urls, noteBase, index, count, lectureNo, lane }) {
  const isPart = count > 1;
  return generateWithFallback({
    accounts: genAccounts,
    models: lane?.models || models,
    strategy: accountStrategy,
    lectureIndex: lectureNo,
    log: (m) => console.log(`[${acct.account}] ${m}`),
    maxAttempts: Math.max(4, genAccounts.length * Math.min(models.length, 3)),
    attempt: async ({ acct: genAcct, model: attemptModel }) => {
      const { markdown, model: usedModel } = await generateMarkdown({
        acct: genAcct,
        publicUrls: urls,
        sysText,
        windowMode,
        model: attemptModel,
        genTimeoutMs: isPart ? chunkGenTimeoutMs : genTimeoutMs,
        retry: cfg.retry,
        extraInstruction: isPart ? partInstruction(index, count, noteBase) : null,
        minChars: isPart ? PART_MIN_CHARS : minNoteChars,
        label: lane?.tag ? `${lane.tag}${genAcct.account}` : null,
        getSession: lane?.getSession || null,
      });
      const cleaned = sanitizeMath(scrubNoteArtifacts(markdown));
      assertValidNote(cleaned, { minChars: isPart ? PART_MIN_CHARS : minNoteChars });
      return { markdown: cleaned, model: usedModel, account: genAcct.account };
    },
  });
}

/**
 * Process one lecture: archive/link the media, split by duration when needed,
 * generate (or reuse) each part with fallback, merge, validate, and save one
 * note. A failed part leaves the successful part cache in place for the next
 * run and never pushes a partial note to Notion.
 */
async function processItem(item, lectureNo, lane) {
  const baseFromFile = item.file || item.dest;
  const noteBase = item.name || basename(baseFromFile, extname(baseFromFile));
  const local = await ensureLocalFile(item, noteBase);
  const localCleanup = local.temp ? [local.file] : [];
  const tempRemote = [];
  const chunkFiles = [];

  try {
    const duration = probeDuration(local.file);
    const chunks = chunkCfg.enabled ? planChunks(duration, chunkCfg) : planChunks(null);
    const multi = chunks.length > 1;

    // Archive/link the original first, so a failed part never loses the source.
    let audio = null;
    if (item.dest) {
      audio = { publicUrl: remoteLink(acct, item.dest), dest: item.dest, cleaned: null };
    } else if (!multi || archive) {
      audio = uploadOriginal(item, local.file);
      if (audio.cleaned) localCleanup.push(audio.cleaned);
      // With archiving off the upload is temporary; delete it after the note.
      if (!archive && !item.dest) tempRemote.push(audio.dest);
    }

    const pdf = slides && item.clip && item.index ? pdfForItem({ clip: item.clip, index: item.index }) : null;
    if (slides && item.clip && item.index && !pdf) {
      console.log(`[${acct.account}] warning: no slide PDF for "${noteBase}" (audio only).`);
    }

    // ---- single-part path -------------------------------------------------
    if (!multi) {
      const urls = [];
      if (audio?.publicUrl) {
        urls.push(audio.publicUrl);
      } else {
        const up = uploadAndLink(acct, local.file, remotePathFor(item.subject));
        urls.push(up.publicUrl);
        if (!archive) tempRemote.push(up.dest);
      }
      if (pdf) {
        const up = uploadAndLink(acct, pdf, remotePathFor(item.subject), `${noteBase}.pdf`);
        urls.push(up.publicUrl);
        if (!archive) tempRemote.push(up.dest);
        console.log(`[${acct.account}] Slide: ${basename(pdf)} -> ${noteBase}.pdf`);
      }
      const res = await generatePart({ urls, noteBase, index: 1, count: 1, lectureNo, lane });
      const notePath = join(notesDir, noteBase + ".md");
      mkdirSync(notesDir, { recursive: true });
      await Bun.write(notePath, res.markdown);
      console.log(`[${acct.account}] Note saved: ${notePath} (${res.markdown.length} chars).`);
      return { notePath, markdown: res.markdown, model: res.model, account: res.account, remoteCleanup: tempRemote, localCleanup, noteBase, chunks: 1 };
    }

    // ---- duration-chunked path -------------------------------------------
    console.log(
      `[${acct.account}] ${noteBase}: ${(duration / 60).toFixed(1)} min -> ${chunks.length} part(s) of ~${(duration / chunks.length / 60).toFixed(1)} min`,
    );
    const cache = new PartCache({ notesDir, noteBase, durationSec: duration, chunking: chunkCfg });
    cache.manifest.count = chunks.length;
    cache.save();

    const mediaDir = join(acct.workDir, "chunks", safeName(noteBase));
    const split = splitMedia(local.file, chunks, mediaDir, {
      log: (m) => console.log(`[${acct.account}] ${m}`),
    });
    for (const s of split) chunkFiles.push(s.path);

    let slidePlans = [];
    if (pdf) {
      slidePlans = planSlideParts(pdf, {
        audioParts: chunks.length,
        maxPages: chunkCfg.slidesMaxPages,
        maxMB: chunkCfg.slidesMaxMB,
        outDir: join(acct.workDir, "slides", safeName(noteBase)),
        log: (m) => console.log(`[${acct.account}] ${m}`),
      });
    }
    const slideUrlCache = new Map();
    const slideUrlFor = (plan) => {
      if (!plan) return null;
      if (slideUrlCache.has(plan.path)) return slideUrlCache.get(plan.path);
      const up = uploadTempPart(plan.path, noteBase, `slides-${pad2(plan.index)}`);
      tempRemote.push(up.dest);
      slideUrlCache.set(plan.path, up.url);
      return up.url;
    };

    let lastModel = model;
    let lastAccount = acct.account;
    let reusedParts = 0;
    for (const c of chunks) {
      const cached = cache.read(c.index);
      if (cached) {
        reusedParts++;
        console.log(`[${acct.account}] part ${c.index}/${chunks.length}: reusing cached note (${cached.length} chars)`);
        continue;
      }
      const media = split.find((s) => s.index === c.index);
      if (!media) throw new Error(`missing split media for part ${c.index}`);
      const partUp = uploadTempPart(media.path, noteBase, `part-${pad2(c.index)}`);
      tempRemote.push(partUp.dest);
      const urls = [partUp.url];

      if (slidePlans.length) {
        const sp = slidePlans[Math.min(c.index - 1, slidePlans.length - 1)];
        const slideUrl = slideUrlFor(sp);
        if (slideUrl) {
          urls.push(slideUrl);
          console.log(
            `[${acct.account}] part ${c.index}/${chunks.length}: slide pages ${sp.pages[0]}-${sp.pages[1]}`,
          );
        }
      }

      console.log(`[${acct.account}] part ${c.index}/${chunks.length}: generating ...`);
      let res;
      try {
        res = await generatePart({ urls, noteBase, index: c.index, count: chunks.length, lectureNo, lane });
      } catch (err) {
        // Record the failure but keep the successful parts; the next run reuses
        // the same boundaries (planKey) and retries only this part.
        cache.markFailed(c.index, err?.message || err);
        throw err;
      }
      cache.write(c.index, res.markdown, {
        model: res.model,
        account: res.account,
        chars: res.markdown.length,
        status: "ok",
      });
      lastModel = res.model;
      lastAccount = res.account;
      console.log(`[${acct.account}] part ${c.index}/${chunks.length}: saved ${res.markdown.length} chars (${res.model} on ${res.account})`);
      // The part is cached; free the local chunk immediately.
      try { unlinkSync(media.path); } catch {}
    }

    const mergedRaw = cache.merged();
    if (!mergedRaw) throw new Error(`part cache is incomplete for "${noteBase}"`);
    const merged = sanitizeMath(scrubNoteArtifacts(mergedRaw));
    assertValidNote(merged, { minChars: minNoteChars });
    const notePath = join(notesDir, noteBase + ".md");
    mkdirSync(notesDir, { recursive: true });
    await Bun.write(notePath, merged);
    console.log(
      `[${acct.account}] Note saved: ${notePath} (${merged.length} chars, ${chunks.length} parts, ${reusedParts} reused).`,
    );
    return { notePath, markdown: merged, model: lastModel, account: lastAccount, remoteCleanup: tempRemote, localCleanup, noteBase, chunks: chunks.length, reusedParts };
  } finally {
    // Temporary chunk/slide uploads are never part of the archive.
    for (const d of tempRemote) removeRemote(acct, d);
    for (const f of chunkFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}

/** Push to Notion and clean up local + temporary remote files. */
async function finalizeNote(res, item) {
  const notionUrl = await pushNoteIfConfigured({
    notePath: res.notePath,
    title: basename(res.notePath, ".md"),
    enabled: notion,
  });
  if (!keepLocal && item.file) {
    try {
      unlinkSync(item.file);
      console.log(`[${acct.account}] Removed local download: ${item.file}`);
    } catch {}
  }
  for (const f of res.localCleanup) {
    try {
      unlinkSync(f);
    } catch {}
  }
  if (!archive) for (const d of res.remoteCleanup) removeRemote(acct, d);
  return notionUrl;
}

let ok = 0;
let failed = 0;
let skipped = 0;
const tally = {
  notesOk: 0,
  notesFailed: 0,
  skippedReuse: 0,
  skippedExpired: expiredUrls.size,
  skippedResume: 0,
  chars: 0,
  byModel: {},
};

// --- shared browser sessions (--jobs) ------------------------------------
// Playwright cannot open the same profile twice, so concurrent lanes share one
// Chromium per account and open a tab each — the same shape as a manual
// multi-tab session. Clipboard steps are serialized in lib/aistudio.js.
const sessions = new Map(); // account name -> Promise<context>

async function sessionFor(account) {
  const existing = sessions.get(account.account);
  if (existing) {
    const ctx = await existing;
    if (!ctx.isClosed?.()) return ctx;
    sessions.delete(account.account);
  }
  const pending = (async () => {
    const ctx = await launchNoteBrowser({
      userDataDir: account.userDataDir,
      headless: windowMode === "headless",
      args:
        windowMode === "tile"
          ? ["--window-size=1100,720", "--window-position=0,0"]
          : undefined,
    });
    await ctx
      .grantPermissions(["clipboard-read", "clipboard-write"])
      .catch((e) => console.log(`[${account.account}] warning: ${e.message}`));
    if (windowMode === "minimize") {
      const first = ctx.pages()[0] ?? (await ctx.newPage());
      await minimizeWindow(first).catch(() => {});
    }
    console.log(`[${account.account}] shared browser ready for ${jobs} tab(s).`);
    return ctx;
  })();
  sessions.set(account.account, pending);
  try {
    return await pending;
  } catch (e) {
    sessions.delete(account.account);
    throw e;
  }
}

async function closeSessions() {
  const pending = [...sessions.entries()];
  sessions.clear();
  await Promise.allSettled(
    pending.map(async ([name, p]) => {
      const ctx = await p.catch(() => null);
      if (!ctx) return;
      const account = genAccounts.find((a) => a.account === name) || acct;
      await closeNoteBrowser(ctx, account.userDataDir);
    }),
  );
}

/** Lane i starts on model i so concurrent tabs do not share one rate limit. */
function laneModels(lane) {
  const n = models.length;
  if (jobs <= 1 || n <= 1) return models;
  const k = lane % n;
  return [...models.slice(k), ...models.slice(0, k)];
}

async function runItem(item, i, lane) {
  const noteBase = item.name || basename(item.file || item.dest || "lecture");
  const tag = lane.tag;
  console.log(
    `\n${tag}[${acct.account}] ===== note ${i + 1}/${work.length}: ${noteBase} [${item.subject}] =====`,
  );

  // Resume: a lecture whose note already exists (locally, in Notion, or in
  // history) is considered done and skipped.
  const noteFile = join(notesDir, noteBase + ".md");
  if (resume && !force) {
    const why = noteDoneReason(item.name, noteFile);
    if (why) {
      console.log(`${tag}[${acct.account}] resume: ${noteBase} — note already exists (${why}), skipping.`);
      skipped++;
      tally.skippedResume++;
      record({ name: item.name, url: item.url, subject: item.subject, status: "skipped", reason: "resume", via: why });
      return;
    }
  }

  const reused = !!item.dest;
  try {
    const res = await processItem(item, i, lane);
    const notionUrl = await finalizeNote(res, item);
    const chars = (res.markdown || "").length;
    const usedModel = res.model || (model === LATEST_FLASH ? "latest-flash" : model);
    ok++;
    tally.notesOk++;
    tally.chars += chars;
    if (reused) tally.skippedReuse++;
    tally.byModel[usedModel] = (tally.byModel[usedModel] || 0) + 1;
    record({
      name: item.name,
      url: item.url,
      subject: item.subject,
      status: "ok",
      account: res.account || acct.account,
      model: usedModel,
      chars,
      reused,
      chunks: res.chunks || 1,
      reusedParts: res.reusedParts || 0,
      notePath: res.notePath,
      notionUrl: notionUrl || null,
    });
  } catch (e) {
    failed++;
    tally.notesFailed++;
    console.log(`${tag}[${acct.account}] ERROR on ${noteBase}: ${e.message}`);
    console.log(`${tag}[${acct.account}] keeping local file for retry.`);
    record({
      name: item.name,
      url: item.url,
      subject: item.subject,
      status: "failed",
      error: e.message || "unknown error",
      kind: e.kind || "unknown",
    });
  }
}

if (jobs > 1) {
  const laneCount = Math.max(1, Math.min(jobs, work.length));
  const lanes = Array.from({ length: laneCount }, (_, id) => ({
    id,
    tag: `L${id + 1} `,
    models: laneModels(id),
    getSession: sessionFor,
  }));
  console.log(
    `[${acct.account}] jobs: ${laneCount} tab(s) in parallel — ` +
      lanes.map((l) => `L${l.id + 1}:${l.models[0]}`).join(", "),
  );
  try {
    await runPool(work, laneCount, (item, i, laneIndex) => runItem(item, i, lanes[laneIndex]));
  } finally {
    await closeSessions();
  }
} else {
  const lane = { id: 0, tag: "", models, getSession: null };
  for (let i = 0; i < work.length; i++) await runItem(work[i], i, lane);
}

if (countersEnabled) {
  const totals = bumpCounters(stateDirectory, { runs: 1, ...tally });
  console.log(
    `\n[${acct.account}] cumulative: ${totals.notesOk} ok / ${totals.notesFailed} failed ` +
      `across ${totals.runs} run(s), ${totals.chars} chars.`,
  );
}

console.log(
  `\n[${acct.account}] done: ${ok} note(s) generated, ${failed} failed, ${skipped} skipped.`,
);
if (failed && !keepLocal) {
  console.log(`[${acct.account}] Failed inputs were kept under ${downloadRoot}/`);
}
process.exit(failed ? 1 : 0);
