// Shared account resolution: one account name drives both systems.
// - Browser profile: ./auth/<account>/            (cloakbrowser persistent context)
// - Rclone config:   ./auth/<account>/rclone.conf (portable, gitignored via auth/)
// - Rclone remote:   <account>:                   (stored inside that config file)
// - Work dir:        ./tmp/<account>/             (all staging/output, gitignored)
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ACCOUNT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function resolveAccount(rawAccount) {
  if (!rawAccount) {
    throw new Error("Usage: bun main.js <account> <local-file> [remote-path]");
  }
  const account = String(rawAccount).trim();
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(
      `Invalid account "${account}". Use letters, numbers, "-" or "_" only (prevents path traversal).`,
    );
  }
  return {
    account,
    userDataDir: `./auth/${account}`,
    rcloneConfig: `./auth/${account}/rclone.conf`,
    rcloneRemote: `${account}:`,
    workDir: `./tmp/${account}`,
  };
}

export function assertBrowserProfile(userDataDir) {
  const account = userDataDir.replace("./auth/", "");
  if (!existsSync(userDataDir)) {
    throw new Error(
      `Browser profile "${userDataDir}" not found. Run: bun login.js ${account}`,
    );
  }
}

export function ensureWorkDir(workDir) {
  mkdirSync(workDir, { recursive: true });
  return workDir;
}

/**
 * Temp-dir policy: create ./tmp/<account>/ if missing,
 * otherwise empty it (remove all entries, keep the dir).
 * Refuses anything outside ./tmp/<account> for safety.
 */
export function ensureCleanWorkDir(workDir) {
  const m = /^.\/tmp\/([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(workDir);
  if (!m) {
    throw new Error(`Refusing to clean unexpected workDir: ${workDir}`);
  }
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
    return { created: true, cleaned: false };
  }
  for (const entry of readdirSync(workDir)) {
    rmSync(`${workDir}/${entry}`, { recursive: true, force: true });
  }
  return { created: false, cleaned: true };
}

function listRemotes(rcloneConfig) {
  const args =
    existsSync(rcloneConfig)
      ? ["--config", rcloneConfig, "listremotes"]
      : ["listremotes"];
  const proc = Bun.spawnSync(["rclone", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const err = proc.stderr?.toString().trim() || "rclone listremotes failed";
    throw new Error(err);
  }
  return proc.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function assertRcloneRemote(rcloneRemote, rcloneConfig) {
  if (!existsSync(rcloneConfig)) {
    throw new Error(
      `Rclone config "${rcloneConfig}" not found. Create it with:\n` +
        `  rclone --config ${rcloneConfig} config\n` +
        `Then name the remote "${rcloneRemote.replace(/:$/, "")}" (type: drive).`,
    );
  }
  const remotes = listRemotes(rcloneConfig);
  if (!remotes.includes(rcloneRemote)) {
    throw new Error(
      `Rclone remote "${rcloneRemote}" not found in ${rcloneConfig} (have: ${remotes.join(", ") || "none"}). Add it with: rclone --config ${rcloneConfig} config`,
    );
  }
}

/** Build an rclone argv with the portable per-account config file. */
export function rcloneArgs(rcloneConfig, ...rest) {
  return ["--config", rcloneConfig, ...rest];
}

/**
 * Remote file size in bytes, or null when the file is not in Drive.
 * Uses `rclone lsjson` (exact path). Byte comparison is valid for
 * uploaded blobs (not native Google Docs, which have no stable size).
 */
export function getRemoteSize(rcloneConfig, remotePath) {
  const proc = Bun.spawnSync(
    ["rclone", ...rcloneArgs(rcloneConfig, "lsjson", "--files-only", remotePath)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return null;
  try {
    const items = JSON.parse(proc.stdout.toString());
    if (Array.isArray(items) && items.length === 1 && typeof items[0].Size === "number") {
      return items[0].Size;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Kill lingering Chromium processes holding this account's profile
 * (e.g. left by a crashed or interrupted run). Matches by exact process name
 * ("chrome"), then filters by the ABSOLUTE profile dir in the command line, so
 * a Chromium playing a *different* profile is never touched. Returns killed PIDs.
 *
 * The match must be against the resolved absolute path: Playwright passes an
 * absolute `--user-data-dir`, so a relative `./auth/<acct>` never appears.
 */
export function killStaleBrowser(userDataDir) {
  const profile = resolve(userDataDir);
  const list = Bun.spawnSync(["pgrep", "-x", "chrome"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (list.exitCode !== 0) return [];
  const killed = [];
  for (const pid of list.stdout.toString().split("\n").map((s) => s.trim())) {
    if (!pid || Number.isNaN(Number(pid))) continue;
    const cmd = Bun.spawnSync(["ps", "-o", "args=", "-p", pid], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const args = cmd.exitCode === 0 ? cmd.stdout.toString() : "";
    if (args.includes(`--user-data-dir=${profile}`) || args.includes(profile)) {
      Bun.spawnSync(["kill", "-TERM", pid], {});
      killed.push(pid);
    }
  }
  return killed;
}
