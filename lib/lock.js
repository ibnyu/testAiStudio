// Single-instance guard per account.
//
// An interrupted run (Ctrl+C, a killed tool, a closed terminal) can keep running
// in the background and hold the browser profile, which makes the NEXT run fail
// or stall. A pid lock makes a second concurrent run refuse to start instead.
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * PID currently holding `lockPath`, or null when it is free or stale.
 * Read-only: never clears the file.
 */
export function lockOwner(lockPath) {
  try {
    if (!existsSync(lockPath)) return null;
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    return pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire `lockPath` or throw if a live process already holds it. Returns a
 * release() function (also wired to process exit / SIGINT / SIGTERM).
 */
export function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number(raw);
    if (pidAlive(pid)) {
      throw new Error(
        `Another run is already active for this account (PID ${pid}). ` +
          `Wait for it to finish, or stop it first (kill ${pid}). Lock: ${lockPath}`,
      );
    }
    console.log(`[lock] clearing stale lock ${lockPath} (PID ${raw} is gone).`);
  }
  writeFileSync(lockPath, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {}
  };
  process.on("exit", release);
  // Sync handlers: run immediately on signal, before any async shutdown work.
  process.on("SIGINT", release);
  process.on("SIGTERM", release);
  return release;
}
