// Unified batch pipeline: clipboard URLs -> yt-dlp download -> Drive archive
// -> AI Studio notes. One command, no intermediate Drive re-download.
//
// Usage:
//   bun batch.js [account] [--file urls.txt] [--dry-run] [--limit N]
//                [--gen-timeout MIN] [--minimize|--tile|--show|--headless]
//                [--no-archive] [--keep-local] [--remote-path Classes]
//                [--notes-dir ./notes]
//
// Defaults: account=ibny, source=clipboard history, window=minimize,
//           archive=on (uploads under Classes/ and keeps it, matching the
//           original batch-dl flat layout), local audio deleted after a note.
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
} from "./lib/pipeline.js";
import {
  readClipboardUrls,
  classify,
  planCommands,
  runPlan,
  subjectForUrl,
} from "./lib/batchdl.js";

const rawArgs = process.argv.slice(2);
let accountArg = null;
let urlsFile = null;
let dryRun = false;
let limit = null;
let genTimeoutMs = 30 * 60 * 1000;
let windowMode = "minimize";
let archive = true;
let keepLocal = false;
let archiveFolder = "Classes";
let bySubject = false;
let notesDir = "./notes";

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
  else if (a === "--by-subject") bySubject = true;
  else if (a === "--keep-local") keepLocal = true;
  else if (a === "--remote-path") archiveFolder = rawArgs[++i];
  else if (a === "--notes-dir") notesDir = rawArgs[++i];
  else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
  else if (!accountArg) accountArg = a;
  else throw new Error(`Unexpected argument: ${a}`);
}
accountArg = accountArg || "ibny";

const acct = resolveAccount(accountArg);
assertBrowserProfile(acct.userDataDir);
assertRcloneRemote(acct.rcloneRemote, acct.rcloneConfig);

// --- gather URLs -----------------------------------------------------------
let urls;
if (urlsFile) {
  if (!existsSync(urlsFile)) throw new Error(`URL file not found: ${urlsFile}`);
  urls = (await Bun.file(urlsFile).text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
} else {
  urls = readClipboardUrls();
}
if (limit) urls = urls.slice(0, limit);

const kind = classify(urls);
const downloadRoot = join(acct.workDir, "downloads");
const plans = planCommands(kind, urls, downloadRoot);

// --- describe --------------------------------------------------------------
console.log(`[${acct.account}] mode:      ${kind}`);
console.log(`[${acct.account}] batch:     ${urls.length} URL(s), in copy order:`);
urls.forEach((u, i) => {
  const tag = kind === "iframe" ? ` [${subjectForUrl(u)}]` : "";
  console.log(`  ${String(i + 1).padStart(2)}. ${u}${tag}`);
});
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
  for (const file of paths) files.push({ file, subject: plan.subject });
}

if (!files.length) {
  console.log(`[${acct.account}] No media files produced; nothing to process.`);
  process.exit(0);
}

// --- process each file -----------------------------------------------------
let ok = 0;
let failed = 0;
for (let i = 0; i < files.length; i++) {
  const { file, subject } = files[i];
  console.log(
    `\n[${acct.account}] ===== note ${i + 1}/${files.length}: ${basename(file)} [${subject}] =====`,
  );
  try {
    const remotePath = archive
      ? bySubject
        ? `${archiveFolder}/${subject}`
        : archiveFolder
      : "uploads/";
    const { dest, publicUrl } = uploadAndLink(acct, file, remotePath);
    await generateNoteFromUrl({
      acct,
      publicUrl,
      noteBaseName: basename(file),
      sysText,
      windowMode,
      genTimeoutMs,
      notesDir,
    });
    if (!keepLocal) {
      unlinkSync(file);
      console.log(`[${acct.account}] Removed local download: ${file}`);
    }
    if (!archive) removeRemote(acct, dest);
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
