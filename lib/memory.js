// Memory headroom guard.
//
// A long AI Studio turn (100k+ characters of rendered markdown, math and a
// thinking trace) can grow a Chromium renderer by gigabytes. When the machine
// runs out of RAM and starts thrashing swap, the whole desktop freezes — the
// browser still "works", it is just starving everything else. Checking headroom
// before a launch is cheap insurance: reap leftover browsers, wait briefly, and
// fail the attempt with a clear message instead of dragging the PC down.
import { readFileSync } from "node:fs";
import { reapOrphanBrowsers } from "./account.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function meminfo() {
  let text = "";
  try {
    text = readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null; // non-Linux / restricted /proc
  }
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  return {
    totalBytes: get("MemTotal"),
    availableBytes: get("MemAvailable"),
    swapTotalBytes: get("SwapTotal"),
    swapFreeBytes: get("SwapFree"),
  };
}

/** Snapshot in MiB, or null when /proc/meminfo is unavailable. */
export function memorySnapshotMB() {
  const m = meminfo();
  if (!m) return null;
  const mb = (b) => (b === null ? null : Math.round(b / (1024 * 1024)));
  return {
    totalMB: mb(m.totalBytes),
    availableMB: mb(m.availableBytes),
    swapTotalMB: mb(m.swapTotalBytes),
    swapFreeMB: mb(m.swapFreeBytes),
  };
}

/**
 * Wait (bounded) until there is enough free RAM/swap to launch another browser.
 * Throws a retryable error when the pressure does not clear — a failed lecture
 * is much better than a frozen desktop.
 */
export async function ensureMemoryHeadroom({
  minFreeMB = Number(process.env.ZS_MIN_FREE_MB || 1000),
  minSwapMB = Number(process.env.ZS_MIN_SWAP_MB || 128),
  waitMs = 90000,
  label = "browser",
  reap = true,
} = {}) {
  const start = Date.now();
  let warned = false;
  let reaped = false;
  for (;;) {
    const snap = memorySnapshotMB();
    if (!snap) return null;
    const lowMem = snap.availableMB !== null && snap.availableMB < minFreeMB;
    const lowSwap = snap.swapFreeMB !== null && snap.swapFreeMB < minSwapMB;
    if (!lowMem && !lowSwap) return snap;

    if (!reaped && reap) {
      // Most pressure at this point is a browser left behind by an earlier
      // crash/freeze; only our own profiles are touched.
      const killed = reapOrphanBrowsers();
      if (killed.length) {
        console.log(`[memory] reaped ${killed.length} orphaned browser(s) before ${label}.`);
      }
      reaped = true;
    }
    if (!warned) {
      warned = true;
      console.log(
        `[memory] low headroom before ${label}: ${snap.availableMB ?? "?"} MB RAM free, ` +
          `${snap.swapFreeMB ?? "?"} MB swap free — waiting for it to clear...`,
      );
    }
    if (Date.now() - start >= waitMs) {
      const err = new Error(
        `Not enough free memory to launch ${label}: ${snap.availableMB ?? "?"} MB RAM / ` +
          `${snap.swapFreeMB ?? "?"} MB swap available (need ${minFreeMB} MB / ${minSwapMB} MB). ` +
          `Close other applications, then retry.`,
      );
      err.retryable = true;
      err.kind = "memory";
      throw err;
    }
    await sleep(3000);
  }
}
