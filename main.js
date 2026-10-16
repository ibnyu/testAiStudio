// Main workflow: one <account> selects BOTH the browser profile and the rclone remote.
//   Browser: ./auth/<account>/            (cloakbrowser persistent context)
//   Rclone:  <account>: in ./auth/<account>/rclone.conf (portable, gitignored)
//   Work:    ./tmp/<account>/             (staging, gitignored; cleaned every run)
//   Notes:   ./notes/<input-name>.md      (global folder, kept across runs)
//   System instructions: ./system_instructions.md (global file, read every run)
// Usage: bun main.js <account> <local-file> [remote-path] [--headless] [--minimize] [--tile]
//   Visible browser is the default; pass --headless to hide it.
import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, basename, resolve } from "node:path";
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

const rawArgs = process.argv.slice(2);
let windowMode = "show";
let headless = false;
let genTimeoutMs = 30 * 60 * 1000; // long generations (e.g. 1h audio) take 5-10+ min
const positionals = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--headless") {
    headless = true;
    windowMode = "headless";
  } else if (a === "--minimize") windowMode = "minimize";
  else if (a === "--tile") windowMode = "tile";
  else if (a === "--show") windowMode = "show";
  else if (a === "--gen-timeout") {
    const mins = Number(rawArgs[++i]);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error("Usage: --gen-timeout <minutes> (positive number)");
    }
    genTimeoutMs = mins * 60 * 1000;
  } else if (a.startsWith("--")) {
    throw new Error(`Unknown flag: ${a}`);
  } else {
    positionals.push(a);
  }
}
const [accountArg, localFile, remotePath = "uploads/"] = positionals;
if (!accountArg || !localFile) {
  throw new Error(
    "Usage: bun main.js <account> <local-file> [remote-path] [--headless] [--minimize] [--tile] [--gen-timeout <minutes>]",
  );
}

const acct = resolveAccount(accountArg);
const { userDataDir } = acct;

// Both sides resolve from the SAME account name.
assertBrowserProfile(userDataDir);
assertRcloneRemote(acct.rcloneRemote, acct.rcloneConfig);
if (!existsSync(localFile)) {
  throw new Error(`Local file not found: ${localFile}`);
}

const sysText = await readSystemInstructions();

// All staging work happens inside the per-account temp dir:
// create it if missing, clean it if it exists.
const dirState = ensureCleanWorkDir(acct.workDir);
console.log(
  `[${acct.account}] Work dir ${acct.workDir}/ (${dirState.created ? "created" : "cleaned"}).`,
);
const staged = join(acct.workDir, basename(localFile));
copyFileSync(localFile, staged);

const { dest, publicUrl } = uploadAndLink(acct, staged, remotePath);

// The prompt input is the Drive link, not a pasted file.
await Bun.write(
  join(acct.workDir, "upload.json"),
  JSON.stringify(
    { account: acct.account, localFile: staged, dest, publicUrl, at: new Date().toISOString() },
    null,
    2,
  ),
);
await Bun.write(join(acct.workDir, "drive_link.txt"), publicUrl + "\n");

// Same account's browser state. Google-side flakes are retried inside the pipeline.
await generateNoteFromUrl({
  acct,
  publicUrl,
  noteBaseName: basename(staged),
  sysText,
  windowMode,
  genTimeoutMs,
});

// Inputs are removed only now that a non-empty note is confirmed on disk.
// Local: only the staged copy inside the work dir — never the user's original file
// unless it is a plain download (see below).
if (resolve(staged).startsWith(resolve(acct.workDir) + "/") && existsSync(staged)) {
  unlinkSync(staged);
  console.log(`[${acct.account}] Removed staged input: ${staged}`);
}
// Original input file: removed per workflow policy, but never project files.
{
  const origResolved = resolve(localFile);
  const protectedDirs = [
    resolve("./auth"),
    resolve("./notes"),
    resolve("./lib"),
    resolve("./tmp"),
  ];
  const protectedFiles = new Set(
    ["./system_instructions.md", "./main.js", "./batch.js", "./login.js", "./package.json"].map(
      (p) => resolve(p),
    ),
  );
  const isStagedCopy = origResolved === resolve(staged);
  const protectedHit =
    protectedFiles.has(origResolved) ||
    protectedDirs.some((d) => origResolved === d || origResolved.startsWith(d + "/"));
  if (protectedHit && !isStagedCopy) {
    console.log(`[${acct.account}] WARNING: refusing to delete protected path: ${localFile}`);
  } else if (!isStagedCopy && existsSync(origResolved)) {
    unlinkSync(origResolved);
    console.log(`[${acct.account}] Removed original input: ${localFile}`);
  }
}
removeRemote(acct, dest);
