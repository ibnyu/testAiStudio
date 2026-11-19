// Browser lifecycle for the note pipeline.
//
// Every launch goes through here so that:
//  - the stealth binary is resolved exactly once (setting CLOAKBROWSER_BINARY_PATH
//    skips cloakbrowser's per-launch ensureBinary/update-check network work),
//  - any Chromium left holding the profile by an interrupted run is reaped
//    before the next launch (otherwise the launch fails/hangs),
//  - a launch that reports "profile already in use" reaps and retries once,
//  - active contexts are closed on SIGINT/SIGTERM so Ctrl+C never leaves a
//    ghost browser (or a locked profile) behind.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import { killStaleBrowser, lowerBrowserPriority } from "./account.js";
import { ensureMemoryHeadroom } from "./memory.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      const e = new Error(`${message} (no response after ${Math.round(ms / 1000)}s).`);
      e.retryable = true;
      throw e;
    }),
  ]);
}

let binaryPromise = null;
/** Resolve the Chromium binary once and pin it via env (skips per-launch work). */
export function ensureBrowserBinary() {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      if (process.env.CLOAKBROWSER_BINARY_PATH) return process.env.CLOAKBROWSER_BINARY_PATH;
      const { ensureBinary } = await import("cloakbrowser");
      const p = await ensureBinary();
      process.env.CLOAKBROWSER_BINARY_PATH = p;
      return p;
    })().catch((e) => {
      binaryPromise = null;
      throw e;
    });
  }
  return binaryPromise;
}

const active = new Map(); // context -> userDataDir

/** Kill any Chromium holding `userDataDir` and wait for it to actually exit. */
export async function reapProfile(userDataDir, { rounds = 24 } = {}) {
  const killed = killStaleBrowser(userDataDir);
  if (killed.length) {
    console.log(`[browser] reaped stale Chromium PID(s): ${killed.join(", ")}`);
  }
  for (let i = 0; i < rounds; i++) {
    if (!killStaleBrowser(userDataDir).length) return killed;
    // A renderer stuck in an uninterruptible loop ignores SIGTERM and keeps
    // eating CPU/RAM; escalate to SIGKILL after ~3 s so it cannot freeze the
    // desktop.
    killStaleBrowser(userDataDir, { signal: i >= 12 ? "KILL" : "TERM" });
    await sleep(250);
  }
  return killed;
}

/** Launch a persistent, stealth Chromium for `userDataDir`. Reaps ghosts first. */
export async function launchNoteBrowser({
  userDataDir,
  headless = false,
  args,
  launchTimeoutMs = 120000,
} = {}) {
  await ensureBrowserBinary();
  await ensureMemoryHeadroom({ label: `browser profile ${userDataDir}` });
  await reapProfile(userDataDir);
  // Memory caps keep a long lecture (huge chat DOM + slide PDF) from growing
  // without bound; the page only needs the rendered text we copy.
  const memoryArgs = [
    "--js-flags=--max-old-space-size=1024",
    "--renderer-process-limit=4",
    "--disk-cache-size=268435456",
  ];
  // /tmp is often a tmpfs on Linux, and Playwright's default
  // `--disable-dev-shm-usage` makes Chromium put shared memory and scratch
  // files there — i.e. in RAM. Point TMPDIR at disk-backed storage so a big
  // renderer cannot quietly consume several gigabytes of memory.
  const tmpDir = resolve("./tmp/browser-tmp");
  mkdirSync(tmpDir, { recursive: true });
  // Playwright's defaults keep an occluded/minimized renderer at full priority
  // and switch off Chromium's IPC-flood protection. Both make a runaway turn
  // able to starve the desktop, so drop those defaults (keeping the two
  // cloakbrowser normally ignores for stealth parity).
  const ignoreDefaultArgs = [
    "--enable-automation",
    "--enable-unsafe-swiftshader",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-ipc-flooding-protection",
  ];
  const launch = () =>
    withTimeout(
      launchPersistentContext({
        userDataDir,
        headless,
        args: [...memoryArgs, ...(args || [])],
        launchOptions: {
          ignoreDefaultArgs,
          env: { ...process.env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir },
        },
      }),
      launchTimeoutMs,
      "Browser launch timed out",
    );
  let context;
  try {
    context = await launch();
  } catch (e) {
    // A profile still locked by a ghost Chromium is recoverable: reap and retry once.
    if (/already in use|ProcessSingleton|SingletonLock|profile.*locked/i.test(e.message || "")) {
      await reapProfile(userDataDir);
      context = await launch();
    } else {
      throw e;
    }
  }
  context.setDefaultTimeout?.(30000);
  // Best-effort: run the browser below the desktop's priority so a wedged
  // renderer cannot starve the machine (see lowerBrowserPriority).
  lowerBrowserPriority(userDataDir);
  // Renderer/GPU/utility processes and page tabs are spawned *after* the
  // browser process starts; re-apply a couple of times so they are lowered too.
  for (const delay of [5000, 20000]) {
    const timer = setTimeout(() => lowerBrowserPriority(userDataDir), delay);
    timer.unref?.();
  }
  active.set(context, userDataDir);
  const drop = () => active.delete(context);
  context.on?.("close", drop);
  context.on?.("disconnected", drop);
  installSignalHandlers();
  return context;
}

/** Close a context (bounded) and reap the profile so the next launch is clean. */
export async function closeNoteBrowser(context, userDataDir) {
  if (!context) return;
  active.delete(context);
  try {
    await withTimeout(context.close(), 20000, "Browser close timed out");
  } catch {
    // fall through to reaping below
  }
  if (userDataDir) await reapProfile(userDataDir, { rounds: 16 });
}

let signalsInstalled = false;
export function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const shutdown = async (sig, code) => {
    console.log(`\n[browser] ${sig} received — closing browser(s)...`);
    // A wedged renderer can make context.close() hang forever, which leaves the
    // process (and its Chromium children) eating the desktop after Ctrl+C. Give
    // it a few seconds, then reap its profile with SIGKILL.
    const forceExit = setTimeout(() => process.exit(code), 10000);
    forceExit.unref?.();
    await Promise.allSettled(
      [...active.entries()].map(async ([context, userDataDir]) => {
        await Promise.race([context.close().catch(() => {}), sleep(5000)]);
        if (userDataDir) killStaleBrowser(userDataDir, { signal: "KILL" });
      }),
    );
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
}
