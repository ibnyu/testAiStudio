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
import { launchPersistentContext } from "cloakbrowser";
import { killStaleBrowser } from "./account.js";

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

const active = new Set();

/** Kill any Chromium holding `userDataDir` and wait for it to actually exit. */
export async function reapProfile(userDataDir, { rounds = 24 } = {}) {
  const killed = killStaleBrowser(userDataDir);
  if (killed.length) {
    console.log(`[browser] reaped stale Chromium PID(s): ${killed.join(", ")}`);
  }
  for (let i = 0; i < rounds; i++) {
    if (!killStaleBrowser(userDataDir).length) return killed;
    killStaleBrowser(userDataDir);
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
  await reapProfile(userDataDir);
  const launch = () =>
    withTimeout(
      launchPersistentContext({
        userDataDir,
        headless,
        ...(args ? { args } : {}),
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
  active.add(context);
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
    await Promise.allSettled([...active].map((c) => c.close().catch(() => {})));
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
}
