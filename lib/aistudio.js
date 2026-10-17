// AI Studio chat flow (selectors verified headless against the live site).
import { DEFAULT_MODEL, newChatUrl } from "./models.js";

// Back-compat default URL (the latest-known Flash model).
export const NEW_CHAT_URL = newChatUrl(DEFAULT_MODEL);

const PROMPT_BOX = 'textarea[aria-label="Enter a prompt"]';
const SYS_CARD = "[data-test-system-instructions-card]";
const SYS_BOX = 'textarea[aria-label="System instructions"]';
const RUN_SETTINGS_TOGGLE = '[aria-label="Toggle run settings panel"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retryable = (msg) => Object.assign(new Error(msg), { retryable: true });

export async function gotoNewChat(page, model) {
  await page.goto(newChatUrl(model), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(PROMPT_BOX, { timeout: 30000 });
}

export async function setSystemInstructions(page, text) {
  // System instructions moved into the right-hand "Run settings" panel.
  // Open that panel first; the instructions card only exists once it is shown.
  if (!(await page.$(SYS_BOX))) {
    if (!(await page.$(SYS_CARD))) {
      await page.click(RUN_SETTINGS_TOGGLE);
      await page.waitForSelector(SYS_CARD, { timeout: 15000 });
    }
    await page.click(SYS_CARD);
    await page.waitForSelector(SYS_BOX, { timeout: 15000 });
  }
  await page.fill(SYS_BOX, text);
  // Site autosaves a few seconds after typing stops.
  await sleep(4000);
  await page.keyboard.press("Escape");
  // Collapse the panel again so it cannot cover the prompt box.
  await page.click(RUN_SETTINGS_TOGGLE).catch(() => {});
  await sleep(500);
}

/**
 * Wait until the pasted file(s) finish loading into the prompt box.
 * Each attachment renders as an `ms-prompt-media` chip; a loading chip reads
 * e.g. "probe.txt Loading..." and a loaded chip e.g. "probe.txt 12 tokens".
 * `expected` is how many chips must be ready (audio + slides = 2).
 */
export async function waitForAttachmentsReady(
  page,
  expected = 1,
  { intervalMs = 3000, timeoutMs = 10 * 60 * 1000 } = {},
) {
  await page.waitForSelector("ms-prompt-media", { timeout: 60000 });
  const start = Date.now();
  for (;;) {
    const s = await page.evaluate((want) => {
      const medias = [...document.querySelectorAll("ms-prompt-media")];
      const popups = [
        ...document.querySelectorAll(
          "[role=alert], mat-snack-bar-container, .mat-mdc-snack-bar-label, [aria-live=assertive]",
        ),
      ]
        .map((e) => (e.innerText || "").trim())
        .filter(Boolean);
      const texts = medias.map((m) => m.innerText || "");
      return {
        count: medias.length,
        ready:
          medias.length >= want &&
          texts.every((t) => /\d+\s+tokens/i.test(t) && !/loading/i.test(t)),
        failed: texts.some((t) => /fail|error|unsupported|too large/i.test(t)),
        text: texts.join(" | ").slice(0, 200),
        popups: popups.slice(0, 3),
      };
    }, expected);
    const popupFail = (s.popups || []).find((t) => /fail/i.test(t));
    if (popupFail) {
      throw retryable(`File load popup: ${popupFail.slice(0, 150)}`);
    }
    if (!s.count) {
      throw retryable("Attachment chip disappeared while the file was loading");
    }
    if (s.failed) throw retryable(`Attachment failed: ${s.text}`);
    if (s.ready) return s;
    if (Date.now() - start > timeoutMs) {
      throw retryable(`Timed out waiting for file(s) to load (last chip: ${s.text})`);
    }
    await sleep(intervalMs);
  }
}

export function waitForAttachmentReady(page, opts) {
  return waitForAttachmentsReady(page, 1, opts);
}

export async function runPrompt(page, { timeoutMs = 60000 } = {}) {
  // Never click Run while it is disabled (e.g. file still loading).
  const start = Date.now();
  for (;;) {
    const enabled = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /^run/i.test((b.getAttribute("aria-label") || b.innerText || "").trim()),
      );
      if (!btn) return "missing";
      return btn.getAttribute("aria-disabled") === "true" ? "disabled" : "ok";
    });
    if (enabled === "ok") break;
    if (enabled === "missing") throw new Error("Run button not found");
    if (Date.now() - start > timeoutMs) {
      throw retryable("Run button stayed disabled (file may still be loading)");
    }
    await sleep(1000);
  }
  await sleep(1000);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /^run/i.test((b.getAttribute("aria-label") || b.innerText || "").trim()),
    );
    if (!btn) throw new Error("Run button not found");
    btn.click();
  });
}

/**
 * Paste a Drive link so the site attaches it as a file
 * (ms-prompt-media chip, textarea stays empty).
 * Method 1: trusted clipboard paste (Ctrl+V).
 * Fallback: synthetic paste event with the link as text/plain.
 */
export async function attachDriveLink(page, url) {
  const count = () =>
    page.evaluate(() => document.querySelectorAll("ms-prompt-media").length);
  const waitForNew = (before) =>
    page.waitForFunction(
      (n) => document.querySelectorAll("ms-prompt-media").length > n,
      before,
      { timeout: 20000 },
    );
  const before = await count();
  // Clipboard read/write needs document focus; a minimized window can lose it.
  await page.bringToFront().catch(() => {});
  await page.evaluate((u) => navigator.clipboard.writeText(u), url);
  await page.focus(PROMPT_BOX);
  await page.keyboard.press("Control+V");
  try {
    await waitForNew(before);
    return "clipboard-paste";
  } catch {
    // Fall through to synthetic paste.
  }
  await page.evaluate((link) => {
    const t = document.querySelector('textarea[aria-label="Enter a prompt"]');
    t.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", link);
    const ev = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    t.dispatchEvent(ev);
  }, url);
  await waitForNew(before);
  return "synthetic-paste";
}

/**
 * Wait until the generation has actually FINISHED. Completion is keyed on the
 * site's own state, not on elapsed time or how many characters have streamed:
 * the "Stop" button (label "progress_activity Stop") disappears and the "Run"
 * button comes back, AND that state holds steady for `confirmMs` with no new
 * output — so a pause between streaming chunks can never be mistaken for done.
 *
 * Notes:
 *  - We only accept completion once generation is known to have started (Stop
 *    was seen, or the last turn grew past its first-sampled length), so we can
 *    never "finish" in the gap right after Run is pressed.
 *  - There is deliberately NO stall/char-based early exit. A long generation is
 *    waited out. `timeoutMs` is only a generous safety net (default 60 min) for
 *    a genuinely wedged UI; override with --gen-timeout.
 * `onProgress` is called roughly every 30s so the caller can show liveness.
 */
export async function waitForDone(
  page,
  {
    intervalMs = 2000,
    confirmMs = 10000,
    timeoutMs = 60 * 60 * 1000,
    onProgress = null,
  } = {},
) {
  const start = Date.now();
  let lastLen = -1;
  let lastChangeAt = start;
  let firstLen = null;
  let firstTurns = null;
  let seenRunning = false;
  let stoppedSince = null;
  let lastReport = 0;

  for (;;) {
    await sleep(intervalMs);
    const s = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("button")].map((b) =>
        (b.getAttribute("aria-label") || b.innerText || "").trim(),
      );
      const turns = [...document.querySelectorAll("ms-chat-turn")];
      const lastTurn = turns[turns.length - 1];
      return {
        stop: labels.some((l) => /stop/i.test(l)),
        run: labels.some((l) => /^run/i.test(l)),
        turns: turns.length,
        len: lastTurn ? (lastTurn.innerText || "").length : 0,
      };
    });
    const now = Date.now();
    if (firstLen === null) {
      firstLen = s.len;
      firstTurns = s.turns;
    }
    if (s.len !== lastLen) {
      lastLen = s.len;
      lastChangeAt = now;
    }

    if (s.stop) {
      // Generation is running — reset the "done" confirmation window.
      seenRunning = true;
      stoppedSince = null;
    } else {
      const started = seenRunning || s.turns > firstTurns || s.len > firstLen;
      if (s.run) {
        if (stoppedSince === null) stoppedSince = now;
        const quiet = now - lastChangeAt;
        const confirmed = now - stoppedSince >= confirmMs && quiet >= confirmMs;
        // Accept once the "not running" state is well confirmed. Require that
        // generation really started, unless a generous grace has elapsed (so an
        // ultra-fast generation can never wedge us waiting for a start signal).
        if (confirmed && (started || now - start >= 30000)) return s;
      } else {
        stoppedSince = null;
      }
    }

    if (onProgress && now - start - lastReport >= 30000) {
      lastReport = now - start;
      onProgress({
        elapsedMs: now - start,
        len: s.len,
        stop: s.stop,
        run: s.run,
      });
    }
    if (now - start > timeoutMs) {
      throw retryable(
        `Timed out after ${Math.round(timeoutMs / 60000)} min waiting for generation to ` +
          `finish (last turn ${s.len} chars, stop button ${s.stop ? "present" : "gone"}).`,
      );
    }
  }
}

/** Reject if `promise` does not settle within `ms` (guards a dead transport). */
export function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw retryable(`${message} (no response after ${Math.round(ms / 1000)}s).`);
    }),
  ]);
}

/** Read the OS clipboard (string) or "" when unavailable. */
async function readClipboard(page) {
  try {
    return (await page.evaluate(() => navigator.clipboard.readText())) || "";
  } catch {
    return "";
  }
}

/** Restore window focus so the clipboard API is not silently denied. */
async function focusForClipboard(page) {
  await page.bringToFront().catch(() => {});
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
  } catch {
    // headless / WM refusal is fine — bringToFront already helps.
  }
}

/**
 * Copy the last response as markdown via the site's "Copy as markdown" action.
 *
 * That action writes to the OS clipboard; reading it immediately can return
 * stale text (e.g. a minimized window that lost clipboard focus), which
 * silently produced near-empty notes. So: record the baseline, click, then
 * poll until the clipboard actually changes to something substantial; retry
 * the click a couple of times; otherwise throw (retryable) so the lecture is
 * retried instead of saving a garbage note.
 */
export async function copyLatestResponseMarkdown(page) {
  const nTurns = await page.evaluate(
    () => document.querySelectorAll("ms-chat-turn").length,
  );
  if (!nTurns) {
    throw retryable(
      "No response turns found — generation may not have run " +
        "(was Run pressed with the file fully loaded?)",
    );
  }
  await focusForClipboard(page);
  const before = await readClipboard(page);
  const pos = await page.evaluate(() => {
    const turns = [...document.querySelectorAll("ms-chat-turn")];
    const r = turns[turns.length - 1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 40 };
  });

  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.mouse.move(pos.x, pos.y);
    await sleep(1200);
    try {
      await page.evaluate(() => {
        const turns = [...document.querySelectorAll("ms-chat-turn")];
        const turn = turns[turns.length - 1];
        const btn = [...turn.querySelectorAll("button")].find((b) =>
          /open options/i.test(b.getAttribute("aria-label") || b.innerText || ""),
        );
        if (!btn) throw new Error("Open options button not found");
        btn.click();
      });
      await page.waitForSelector("text=Copy as markdown", { timeout: 15000 });
      await page.click("text=Copy as markdown");
    } catch (e) {
      last = `menu error: ${e.message}`;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(800);
      continue;
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(600);
      const text = await readClipboard(page);
      if (text && text.length >= 200 && text !== before) return text;
      last = text;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(800);
  }
  throw retryable(
    `"Copy as markdown" did not update the clipboard ` +
      `(last: ${JSON.stringify((last || "").slice(0, 40))}, ${(last || "").length} chars).`,
  );
}
