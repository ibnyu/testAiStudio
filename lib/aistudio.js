// AI Studio chat flow (selectors verified headless against the live site).
import { DEFAULT_MODEL, newChatUrl } from "./models.js";
import { classifyChatError, ERROR_TEXT_RE, BANNER_ERROR_RE, FileLoadError } from "./errors.js";
import { looksLikeReasoning, looksLikePageDump } from "./validate.js";
import { readCapturedClipboard } from "./clipboard-capture.js";
import { criticalMemoryPressure } from "./memory.js";

// Back-compat default URL (the latest-known Flash model).
export const NEW_CHAT_URL = newChatUrl(DEFAULT_MODEL);

const PROMPT_BOX = 'textarea[aria-label="Enter a prompt"]';
const SYS_CARD = "[data-test-system-instructions-card]";
const SYS_BOX = 'textarea[aria-label="System instructions"]';
const RUN_SETTINGS_TOGGLE = '[aria-label="Toggle run settings panel"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The OS clipboard is global, so two tabs in flight would overwrite each
// other's text between "write the link" and "press Ctrl+V". Serialize every
// clipboard-touching step through one promise chain.
let clipboardChain = Promise.resolve();
export function withClipboard(fn) {
  const run = clipboardChain.then(fn, fn);
  clipboardChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

const retryable = (msg) => Object.assign(new Error(msg), { retryable: true });

/**
 * Read a visible AI Studio error banner, or null. This is deliberately scoped
 * to alert/snackbar nodes and to the *last* chat turn, so lecture text about
 * e.g. "rate laws" is never mistaken for a Google-side rate-limit error.
 *
 * The pattern comes from `ERROR_TEXT_RE` (built from lib/errors.js PATTERNS) so
 * a newly classified failure — e.g. the recitation/copyright block — is read
 * from the page without editing two regexes in lockstep.
 */
export async function readChatError(page, { deep = true } = {}) {
  try {
    return await page.evaluate(
      ({ bannerSource, textSource, deep }) => {
        // Banners are error UI, so short numeric codes (429/403/5xx) are safe.
        // The last chat turn is the model's answer; there only unambiguous
        // phrases are trusted, or a networking lecture would abort on "429".
        const bannerRe = new RegExp(bannerSource, "i");
        const textRe = new RegExp(textSource, "i");
        // textContent (not innerText) throughout: a layout-forcing read on a
        // streaming 100k-char turn pins a core on every poll.
        const nodes = [
          ...document.querySelectorAll(
            "[role=alert], mat-snack-bar-container, .mat-mdc-snack-bar-label, [aria-live=assertive], [class*='error-message'], [class*='error-banner'], [class*='blocked']",
          ),
        ];
        for (const n of nodes) {
          const t = (n.textContent || "").trim();
          if (t && t.length < 4000 && bannerRe.test(t)) return t.slice(0, 500);
        }
        if (!deep) return null;
        // Walk turns from the end: the newest failure is in the last one or two
        // turns, so a long transcript is never fully serialized each poll.
        const turns = [...document.querySelectorAll("ms-chat-turn")];
        for (let i = turns.length - 1; i >= Math.max(0, turns.length - 2); i--) {
          const turn = turns[i];
          for (const n of turn.querySelectorAll(
            "[class*='error'], [class*='warning'], [class*='blocked'], [role=alert]",
          )) {
            const t = (n.textContent || "").trim();
            if (t && bannerRe.test(t)) return t.slice(0, 500);
          }
          const text = (turn.textContent || "").trim();
          // A verification/quota page often renders as the whole (short) turn.
          if (text.length && text.length < 1200 && textRe.test(text)) return text.slice(0, 500);
          // A blocked generation can render part of an answer and then the
          // notice, so scan only the tail of a long turn.
          if (text.length >= 1200) {
            const tail = text.slice(-1000);
            const m = tail.match(textRe);
            if (m) return tail.slice(Math.max(0, m.index - 100), m.index + 400).trim();
          }
        }
        return null;
      },
      {
        bannerSource: BANNER_ERROR_RE.source,
        textSource: ERROR_TEXT_RE.source,
        deep,
      },
    );
  } catch {
    return null;
  }
}

/** Throw a typed error when the page is showing a known chat failure. */
export async function assertNoChatError(page) {
  const text = await readChatError(page);
  if (text) throw classifyChatError(text);
  return null;
}

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
    const popupFail = (s.popups || []).find((t) => /fail|error|quota|verify/i.test(t));
    if (popupFail) {
      throw classifyChatError(popupFail, `File load popup: ${popupFail.slice(0, 150)}`);
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

/** Drive file id from a Drive link ("...?id=X", "/file/d/X", "/d/X"), else "". */
export function driveFileId(url) {
  const s = String(url || "");
  const q = /[?&]id=([\w-]+)/.exec(s);
  if (q) return q[1];
  const f = /\/file\/d\/([\w-]+)/.exec(s);
  if (f) return f[1];
  const d = /\/d\/([\w-]+)/.exec(s);
  return d ? d[1] : "";
}

/** Empty the prompt box with real key events, so the site's state follows. */
async function clearPromptBox(page) {
  await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    if (t && t.value) {
      t.focus();
      t.select();
    }
  }, PROMPT_BOX);
  await page.keyboard.press("Backspace").catch(() => {});
}

/**
 * Paste a Drive link so the site attaches it as a file
 * (ms-prompt-media chip, textarea stays empty).
 *
 * The trusted route is a real Ctrl+V, but that reads the *OS* clipboard — a
 * resource shared with every other app. If the write below is denied, or the
 * user copies something (e.g. an image) at that moment, a plain Ctrl+V would
 * attach the wrong item and the note would be generated from it. So any real
 * paste is wrapped in an in-page guard that cancels the event unless the
 * clipboard actually carries our link; the DOM paste path (DataTransfer, no
 * clipboard at all) is then used instead. The clipboard is restored afterwards.
 */
export function attachDriveLink(page, url, opts) {
  return withClipboard(() => attachDriveLinkUnlocked(page, url, opts));
}

async function attachDriveLinkUnlocked(page, url, { expectedName = null } = {}) {
  const count = () =>
    page.evaluate(() => document.querySelectorAll("ms-prompt-media").length);
  const waitForNew = (before) =>
    page.waitForFunction(
      (n) => document.querySelectorAll("ms-prompt-media").length > n,
      before,
      { timeout: 20000 },
    );

  const before = await count();
  const previousClipboard = await readClipboard(page);
  let method = null;

  // --- 1. trusted paste, guarded against foreign clipboard content ----------
  await page.evaluate(
    ({ link, id }) => {
      const isOurs = (text) => {
        const s = String(text || "");
        if (!s) return false;
        if (s.includes(link)) return true;
        return !!id && s.includes(id);
      };
      const state = { blocked: false, types: null, handler: null };
      state.handler = (e) => {
        const dt = e.clipboardData;
        state.types = dt ? [...dt.types] : [];
        if (dt && isOurs(dt.getData("text/plain"))) return;
        state.blocked = true;
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      window.__zsPasteGuard = state;
      window.addEventListener("paste", state.handler, true);
    },
    { link: url, id: driveFileId(url) },
  );

  // Clipboard write needs document focus; a minimized window can lose it.
  await focusForClipboard(page);
  const wrote = await page
    .evaluate(async (u) => {
      try {
        await navigator.clipboard.writeText(u);
        // Reading back is allowed only with permission; when it is denied the
        // paste guard still decides, so treat that as "maybe written".
        try {
          return (await navigator.clipboard.readText()) === u;
        } catch {
          return true;
        }
      } catch {
        return false;
      }
    }, url)
    .catch(() => false);

  if (wrote) {
    await page.focus(PROMPT_BOX);
    await page.keyboard.press("Control+V");
    try {
      await waitForNew(before);
      method = "clipboard-paste";
    } catch {
      method = null;
    }
  }

  const guard = await page.evaluate(() => {
    const st = window.__zsPasteGuard;
    if (st) window.removeEventListener("paste", st.handler, true);
    delete window.__zsPasteGuard;
    return { blocked: !!st?.blocked, types: st?.types ?? null };
  });

  if (guard.blocked) {
    console.log(
      `[attach] clipboard held ${guard.types?.join(", ") || "something else"} instead of the Drive link ` +
        `— kept it out and attached via the DOM paste path.`,
    );
    if (method) {
      // Defensive: a foreign item reached the site, so nothing on this page is
      // trustworthy any more. Retry with a fresh browser instead of using it.
      await clearPromptBox(page);
      throw retryable("clipboard paste attached foreign content — retrying with a fresh page");
    }
  }

  // --- 2. DOM paste: no clipboard involved, so it cannot pick up user data --
  if (!method) {
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
    try {
      await waitForNew(before);
    } catch {
      throw retryable(
        `could not attach the Drive link (a real paste was ${guard.blocked ? "blocked" : "unavailable"} ` +
          `and the site ignored the DOM paste)`,
      );
    }
    method = "synthetic-paste";
  }

  // --- 3. verify the chip really is a document, not a pasted image ----------
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll("ms-prompt-media")].map((m) => ({
      text: (m.innerText || "").replace(/\s+/g, " ").trim(),
      image: !!m.querySelector('img[src^="blob:"], img[src^="data:"]'),
    })),
  );
  const fresh = chips.slice(before);
  const wantsImage = /\.(png|jpe?g|gif|webp)$/i.test(expectedName || "");
  const looksImage =
    !wantsImage &&
    fresh.some((c) => c.image || /^image\b|\.(png|jpe?g|gif|webp)\b/i.test(c.text));
  if (fresh.length !== 1 || looksImage) {
    await clearPromptBox(page);
    throw retryable(
      `attached the wrong item (${fresh.map((c) => c.text).join(" | ") || "no file name"}) ` +
        `instead of the Drive link`,
    );
  }

  // A default paste also drops the link's text into the box; the prompt must
  // stay empty (everything else is sent as system instructions).
  const strayText = await page.evaluate((sel) => document.querySelector(sel)?.value ?? "", PROMPT_BOX);
  if (strayText.trim() && strayText.includes(driveFileId(url) || url)) {
    await clearPromptBox(page);
  }

  // Leave the user's clipboard as it was (best effort; images cannot be read).
  if (previousClipboard && previousClipboard !== url) {
    await page
      .evaluate((t) => navigator.clipboard.writeText(t), previousClipboard)
      .catch(() => {});
  }
  return method;
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
 *  - A live generation keeps adding text (even its thinking trace). `stallMs`
 *    with zero growth means the turn is wedged (usually a silent rate limit), so
 *    the attempt fails early instead of waiting out the full ceiling. `timeoutMs`
 *    remains the absolute cap for a genuinely slow response.
 * `onProgress` is called roughly every 30s so the caller can show liveness.
 */
export async function waitForDone(
  page,
  {
    intervalMs = 2000,
    confirmMs = 10000,
    timeoutMs = 10 * 60 * 1000,
    // A live generation keeps adding text (including the thinking trace). No
    // growth for this long means the turn is wedged — most often the site hit a
    // rate limit and stopped without a notice we can see. Waiting the full
    // 20-26 min timeout burns the run, so fail early and let the model/account
    // policy take over.
    stallMs = 6 * 60 * 1000,
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
    // Poll less often once the turn is huge: each evaluate on a 150k-char
    // answer still costs CPU, and a wedged turn will not finish in the next
    // second anyway. This keeps a long/stalled generation from pinning a core.
    const pollMs = lastLen > 150000 ? 8000 : lastLen > 50000 ? 5000 : intervalMs;
    await sleep(pollMs);
    const s = await withTimeout(
      page.evaluate(() => {
        const labels = [...document.querySelectorAll("button")].map((b) =>
          (b.getAttribute("aria-label") || b.textContent || "").trim(),
        );
        const turns = [...document.querySelectorAll("ms-chat-turn")];
        const lastTurn = turns[turns.length - 1];
        // textContent, not innerText: innerText forces layout on every poll.
        return {
          stop: labels.some((l) => /stop/i.test(l)),
          run: labels.some((l) => /^run/i.test(l)),
          turns: turns.length,
          len: lastTurn ? (lastTurn.textContent || "").length : 0,
        };
      }),
      pollMs + 15000,
      "Reading the chat state timed out",
    );
    const now = Date.now();
    // Fail fast on verification/quota/model/file errors instead of waiting the
    // full generation timeout for a response that will never arrive. Only scan
    // the turn body once generation has stopped; banners are always checked.
    const chatError = await withTimeout(
      readChatError(page, { deep: !s.stop }),
      20000,
      "Reading the chat error timed out",
    );
    if (chatError) throw classifyChatError(chatError);

    // Last line of defence against a desktop freeze: if the renderer has eaten
    // the machine's RAM/swap, abort this turn now. The pipeline closes the
    // browser, which releases the memory, and the lecture is reported failed
    // instead of taking the whole desktop down.
    const pressure = criticalMemoryPressure();
    if (pressure) {
      throw Object.assign(
        new Error(
          `Generation aborted to protect the desktop: ${pressure.reason}. ` +
            `Close other applications, then retry.`,
        ),
        { kind: "memory", retryable: true },
      );
    }
    if (firstLen === null) {
      firstLen = s.len;
      firstTurns = s.turns;
    }
    if (s.len !== lastLen) {
      lastLen = s.len;
      lastChangeAt = now;
    }
    if (seenRunning && now - lastChangeAt > stallMs) {
      throw retryable(
        `Generation stalled: no new output for ${Math.round(stallMs / 60000)} min ` +
          `(last turn ${s.len} chars, stop button ${s.stop ? "present" : "gone"}).`,
      );
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
    // Without a timeout a denied/unfocused clipboard read can hang for the
    // whole generation budget; treat any failure as "no clipboard".
    return (
      (await withTimeout(
        page.evaluate(() => navigator.clipboard.readText()),
        5000,
        "clipboard read",
      )) || ""
    );
  } catch {
    return "";
  }
}

// Clipboard reads need the `clipboard-read` permission in Chromium; without it
// a background/minimized window queues readText() until focus returns, which is
// exactly how the old DOM fallback produced corrupted notes. Grant it once per
// context (the context only ever hosts AI Studio).
let clipboardPermission = null;
function ensureClipboardPermission(page) {
  if (!clipboardPermission) {
    clipboardPermission = page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: "https://aistudio.google.com",
      })
      .catch(() => {});
  }
  return clipboardPermission;
}

/** Restore window focus so the clipboard API is not silently denied. */
async function focusForClipboard(page) {
  await page.bringToFront().catch(() => {});
  try {
    const session = await page.context().newCDPSession(page);
    // Clipboard reads/writes require a focused document. When the desktop
    // focus is elsewhere (terminal, another app) Chromium queues the call until
    // focus returns — the old cause of "copy failed" and DOM-dump fallbacks.
    // Focus emulation makes the page behave as focused regardless of the WM.
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
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
 * Best-effort recovery of the last response as Markdown straight from the
 * rendered DOM, used only when the clipboard copy fails. Equations are recovered
 * losslessly from KaTeX's embedded TeX annotation; headings/lists/tables/code are
 * reconstructed. Returns "" when nothing substantial is found.
 */
export async function extractLatestResponseMarkdown(page) {
  return page.evaluate(() => {
    const turns = [...document.querySelectorAll("ms-chat-turn")];
    const turn = turns[turns.length - 1];
    if (!turn) return "";

    // Thinking-model traces render in their own panel(s). They must never be
    // reconstructed as the answer, so every walk below skips them.
    const inThoughts = (el) => {
      for (let n = el; n && n !== turn; n = n.parentElement) {
        const tag = (n.tagName || "").toLowerCase();
        const cls = typeof n.className === "string" ? n.className : "";
        const label = n.getAttribute ? n.getAttribute("aria-label") || "" : "";
        if (/thought|thinking|reasoning/i.test(`${tag} ${cls} ${label}`)) return true;
      }
      return false;
    };

    // AI Studio renders math as ms-katex > pre > code > span.katex. The TeX
    // source lives in the embedded MathML annotation; textContent would return
    // the visual text + MathML + annotation concatenated (three copies).
    const texOf = (el) => {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      return ann ? ann.textContent.trim() : null;
    };
    const isMath = (el) =>
      el.matches?.("ms-katex, .katex, .katex-display") ||
      (el.matches?.("pre, code") && !!el.querySelector?.(":scope .katex, :scope ms-katex"));
    const isDisplayMath = (el) =>
      el.classList?.contains("katex-display") ||
      el.hasAttribute?.("display") ||
      (el.matches?.("ms-katex") && !!el.querySelector?.(".katex-display"));
    const mathMd = (el) => {
      const tex = texOf(el);
      if (tex == null) return null;
      const d = isDisplayMath(el) ? "$$" : "$";
      return d + tex + d;
    };

    // Page chrome: action bars, hover toolbars, icon fonts, widget buttons.
    const UI_TAGS = new Set(["button", "svg", "mat-icon", "script", "style", "noscript"]);
    const UI_CLASS =
      /material-symbols|actions-container|turn-footer|turn-information|feedback|toolbar|chat-turn-options/i;
    const isChrome = (el) => {
      const tag = (el.tagName || "").toLowerCase();
      if (UI_TAGS.has(tag)) return true;
      if (el.matches?.("ms-chat-turn-options, ms-chat-turn-actions")) return true;
      const cls = typeof el.className === "string" ? el.className : "";
      return UI_CLASS.test(cls);
    };

    const sq = (s) => s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();

    const inline = (node) => {
      let out = "";
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.textContent; continue; }
        if (child.nodeType !== 1) continue;
        if (isChrome(child)) continue;
        if (isMath(child)) {
          const m = mathMd(child);
          if (m != null) { out += m; continue; }
        }
        const tag = child.tagName.toLowerCase();
        if (tag === "strong" || tag === "b") { out += "**" + inline(child) + "**"; continue; }
        if (tag === "em" || tag === "i") { out += "*" + inline(child) + "*"; continue; }
        if (tag === "code") { out += "`" + inline(child).replace(/`/g, "\\`") + "`"; continue; }
        if (tag === "a") { out += "[" + inline(child) + "](" + (child.getAttribute("href") || "") + ")"; continue; }
        if (tag === "br") { out += "  \n"; continue; }
        if (tag === "img") {
          const src = child.getAttribute("src") || "";
          // data: URIs are diagram-widget blobs, not notes; skip them.
          if (/^https?:\/\//i.test(src)) out += "![](" + src + ")";
          continue;
        }
        out += inline(child);
      }
      return out;
    };

    const table = (node) => {
      const rows = [...node.querySelectorAll("tr")];
      if (!rows.length) return "";
      const cells = (tr) =>
        [...tr.querySelectorAll("td, th")].map((td) => sq(inline(td)).replace(/\|/g, "\\|"));
      const head = cells(rows[0]);
      let out = "| " + head.join(" | ") + " |\n| " + head.map(() => "---").join(" | ") + " |\n";
      for (const tr of rows.slice(1)) out += "| " + cells(tr).join(" | ") + " |\n";
      return out + "\n";
    };

    const list = (node, ordered, depth) => {
      let out = "", n = 1;
      // Items can be wrapped in ms-cmark-node, so select the direct li set.
      const items = [...node.querySelectorAll("li")].filter((li) => li.closest("ul, ol") === node);
      for (const li of items) {
        const nested = [...li.querySelectorAll("ul, ol")].filter((l) => l.closest("li") === li);
        const clone = li.cloneNode(true);
        for (const c of [...clone.querySelectorAll("ul, ol")]) c.remove();
        out +=
          "  ".repeat(depth) +
          (ordered ? `${n}. ` : "- ") +
          sq(inline(clone)).replace(/\n+/g, " ") +
          "\n";
        n++;
        for (const sub of nested) out += list(sub, /^ol$/i.test(sub.tagName), depth + 1);
      }
      return out;
    };

    const blocks = (node, depth = 0) => {
      let out = "";
      for (const child of node.children) {
        if (inThoughts(child) || isChrome(child)) continue;
        const tag = child.tagName.toLowerCase();
        if (isMath(child)) {
          const m = mathMd(child);
          if (m != null) { out += m + "\n\n"; continue; }
        }
        if (child.classList?.contains("table-container")) {
          const tb = child.querySelector("table");
          if (tb) { out += table(tb); continue; }
        }
        if (/^h[1-6]$/.test(tag)) {
          out += "#".repeat(Number(tag[1])) + " " + sq(inline(child)) + "\n\n";
          continue;
        }
        if (tag === "p") {
          const t = sq(inline(child));
          if (t) out += t + "\n\n";
          continue;
        }
        if (tag === "ul" || tag === "ol") { out += list(child, tag === "ol", depth) + "\n"; continue; }
        if (tag === "pre") {
          // A pre that wraps KaTeX is math, not a code block.
          if (child.querySelector(".katex, ms-katex")) {
            const t = sq(inline(child));
            if (t) out += t + "\n\n";
          } else {
            out += "```\n" + (child.textContent || "").replace(/\n+$/, "") + "\n```\n\n";
          }
          continue;
        }
        if (tag === "table") { out += table(child); continue; }
        if (tag === "blockquote") {
          out += inline(child).trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
          continue;
        }
        // Generic wrappers (ms-text-chunk, ms-cmark-node, div, section):
        // recurse when they contain block structure, otherwise treat as text.
        const hasBlock = child.querySelector(
          ":scope h1, :scope h2, :scope h3, :scope h4, :scope h5, :scope h6, :scope p, :scope ul, :scope ol, :scope pre, :scope table, :scope blockquote, :scope div",
        );
        if (hasBlock) { out += blocks(child, depth); continue; }
        const t = sq(inline(child));
        if (t) out += t + "\n\n";
      }
      return out;
    };

    // The answer lives in the last ms-text-chunk of the turn. Older markup used
    // .markdown / ms-chat-turn-content; fall back to the turn itself.
    const chunks = [...turn.querySelectorAll("ms-text-chunk")].filter((c) => !inThoughts(c));
    let root = chunks[chunks.length - 1];
    if (!root) {
      root =
        [...turn.querySelectorAll(".markdown, ms-chat-turn-content, [class*='turn-content']")]
          .filter((c) => !inThoughts(c))
          .pop() || turn;
    }
    return blocks(root)
      .split("\n")
      .filter((l) => !/^\s*(edit|more_vert|thumb_up|thumb_down|content_copy|fullscreen|expand_less|code)\s*$/i.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
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
export function copyLatestResponseMarkdown(page) {
  return withClipboard(() => copyLatestResponseMarkdownUnlocked(page));
}

async function copyLatestResponseMarkdownUnlocked(page) {
  const nTurns = await page.evaluate(
    () => document.querySelectorAll("ms-chat-turn").length,
  );
  if (!nTurns) {
    throw retryable(
      "No response turns found — generation may not have run " +
        "(was Run pressed with the file fully loaded?)",
    );
  }
  await ensureClipboardPermission(page);
  await focusForClipboard(page);
  const before = await readClipboard(page);
  // Baseline for the in-page capture (installed by lib/browser.js): only a
  // *new* capture counts as this click's result.
  let capturedSeq = (await readCapturedClipboard(page)).seq;
  const pos = await page.evaluate(() => {
    const turns = [...document.querySelectorAll("ms-chat-turn")];
    const r = turns[turns.length - 1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 40 };
  });

  let last = "";
  let reasoningCopy = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.mouse.move(pos.x, pos.y);
    await sleep(1200);
    try {
      await page.evaluate(() => {
        const turn = [...document.querySelectorAll("ms-chat-turn")].pop();
        // A thinking model renders its trace in a panel that has its own action
        // menu; opening the FIRST menu copies the reasoning, not the answer.
        // The answer's menu comes later in DOM order, so take the last one and
        // never a button that lives inside a thinking panel.
        const inThoughts = (el) => {
          for (let n = el; n && n !== turn; n = n.parentElement) {
            const tag = (n.tagName || "").toLowerCase();
            const cls = typeof n.className === "string" ? n.className : "";
            const label = n.getAttribute ? n.getAttribute("aria-label") || "" : "";
            if (/thought|thinking|reasoning/i.test(`${tag} ${cls} ${label}`)) return true;
          }
          return false;
        };
        const buttons = [...turn.querySelectorAll("button")].filter((b) =>
          /open options/i.test(b.getAttribute("aria-label") || b.innerText || ""),
        );
        const btn = buttons.filter((b) => !inThoughts(b)).pop() || buttons.pop();
        if (!btn) throw new Error("Open options button not found");
        btn.click();
      });
      await page.waitForSelector("text=Copy as markdown", { timeout: 15000 });
      // Several menus can be in the DOM at once (thinking panel + answer), so
      // click the last *visible* item: that is the menu just opened.
      await page
        .locator("text=Copy as markdown")
        .filter({ visible: true })
        .last()
        .click({ timeout: 15000 });
    } catch (e) {
      last = `menu error: ${e.message}`;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(800);
      continue;
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(600);
      // Prefer the in-page capture: this Chromium can report a successful
      // clipboard write while the OS clipboard never changes.
      const cap = await readCapturedClipboard(page);
      const fresh = cap.seq > capturedSeq ? cap.text : "";
      if (fresh) capturedSeq = cap.seq;
      const osText = fresh ? "" : await readClipboard(page);
      const text = fresh || osText;
      const changed = fresh
        ? text.length >= 200
        : !!text && text.length >= 200 && text !== before;
      if (changed) {
        if (looksLikeReasoning(text)) {
          // The menu belonged to the thinking panel. Do not save or cache it;
          // try the rendered answer below, then retry the lecture if needed.
          reasoningCopy = text;
          break;
        }
        if (looksLikePageDump(text)) {
          // Some clipboard flavours return the rendered page (toolbar labels,
          // collapsed layout). Never save that; retry, then reconstruct.
          last = `page dump (${text.length} chars)`;
          continue;
        }
        return text;
      }
      last = text;
    }
    if (reasoningCopy) break;
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(800);
  }
  // Reconstruct the note from the rendered response (thinking panels excluded):
  // this rescues a finished generation whose clipboard write was denied, and it
  // is also the way out when the site copied the reasoning panel.
  try {
    const dom = (await extractLatestResponseMarkdown(page)).trim();
    if (dom.length >= 200 && !looksLikeReasoning(dom) && !looksLikePageDump(dom)) {
      console.log(
        reasoningCopy
          ? `[copy] the site copied the model's thinking — recovered ${dom.length} chars from the rendered answer instead.`
          : `[copy] clipboard copy failed (last: ${JSON.stringify((last || "").slice(0, 40))}) — recovered ${dom.length} chars from the rendered response instead.`,
      );
      return dom;
    }
    if (dom.length >= 200) {
      if (looksLikePageDump(dom)) {
        throw retryable(
          "the rendered page could not be reconstructed as clean Markdown (page dump detected) — retrying the lecture",
        );
      }
      reasoningCopy = dom;
    }
  } catch (e) {
    if (e?.retryable) throw e;
    // fall through to the retryable error
  }
  if (reasoningCopy) {
    throw retryable(
      "the site copied the model's reasoning trace instead of the answer — retrying the lecture",
    );
  }
  throw retryable(
    `"Copy as markdown" did not update the clipboard ` +
      `(last: ${JSON.stringify((last || "").slice(0, 40))}, ${(last || "").length} chars).`,
  );
}
