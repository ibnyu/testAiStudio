// AI Studio chat flow (selectors verified headless against the live site).
export const NEW_CHAT_URL =
  "https://aistudio.google.com/prompts/new_chat?model=gemini-3.8-flash";

const PROMPT_BOX = 'textarea[aria-label="Enter a prompt"]';
const SYS_CARD = "[data-test-system-instructions-card]";
const SYS_BOX = 'textarea[aria-label="System instructions"]';
const RUN_SETTINGS_TOGGLE = '[aria-label="Toggle run settings panel"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retryable = (msg) => Object.assign(new Error(msg), { retryable: true });

export async function gotoNewChat(page) {
  await page.goto(NEW_CHAT_URL, { waitUntil: "domcontentloaded" });
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
 * Wait until the pasted file finishes loading into the prompt box.
 * Loading chip reads e.g. "probe.txt Loading..."; loaded chip reads
 * e.g. "probe.txt 12 tokens". Production files can take 5+ minutes.
 */
export async function waitForAttachmentReady(
  page,
  { intervalMs = 3000, timeoutMs = 10 * 60 * 1000 } = {},
) {
  await page.waitForSelector("ms-prompt-media", { timeout: 60000 });
  const start = Date.now();
  for (;;) {
    const s = await page.evaluate(() => {
      const m = document.querySelector("ms-prompt-media");
      const popups = [
        ...document.querySelectorAll(
          "[role=alert], mat-snack-bar-container, .mat-mdc-snack-bar-label, [aria-live=assertive]",
        ),
      ]
        .map((e) => (e.innerText || "").trim())
        .filter(Boolean);
      if (!m) return { present: false, popups };
      const text = m.innerText || "";
      return {
        present: true,
        ready: /\d+\s+tokens/i.test(text) && !/loading/i.test(text),
        failed: /fail|error|unsupported|too large/i.test(text),
        text: text.slice(0, 200),
        popups: popups.slice(0, 3),
      };
    });
    const popupFail = (s.popups || []).find((t) => /fail/i.test(t));
    if (popupFail) {
      throw retryable(`File load popup: ${popupFail.slice(0, 150)}`);
    }
    if (!s.present) {
      throw retryable("Attachment chip disappeared while the file was loading");
    }
    if (s.failed) throw retryable(`Attachment failed: ${s.text}`);
    if (s.ready) return s;
    if (Date.now() - start > timeoutMs) {
      throw retryable(
        `Timed out waiting for file to load (last chip: ${s.text})`,
      );
    }
    await sleep(intervalMs);
  }
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
  await page.evaluate((u) => navigator.clipboard.writeText(u), url);
  await page.focus(PROMPT_BOX);
  await page.keyboard.press("Control+V");
  try {
    await page.waitForSelector("ms-prompt-media", { timeout: 20000 });
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
  await page.waitForSelector("ms-prompt-media", { timeout: 20000 });
  return "synthetic-paste";
}

/**
 * Done = Stop button gone + Run button back + body text length stable.
 * (Stop matches /stop/i anywhere: its label is "progress_activity Stop".)
 */
export async function waitForDone(
  page,
  { intervalMs = 3000, stableRounds = 2, timeoutMs = 30 * 60 * 1000 } = {},
) {
  const start = Date.now();
  let lastLen = -1;
  let stable = 0;
  for (;;) {
    await sleep(intervalMs);
    const s = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("button")].map((b) =>
        (b.getAttribute("aria-label") || b.innerText || "").trim(),
      );
      return {
        stop: labels.some((l) => /stop/i.test(l)),
        run: labels.some((l) => /^run/i.test(l)),
        len: document.body.innerText.length,
      };
    });
    if (s.run && !s.stop && s.len === lastLen) {
      if (++stable >= stableRounds) return s;
    } else {
      stable = 0;
    }
    lastLen = s.len;
    if (Date.now() - start > timeoutMs) {
      throw retryable("Timed out waiting for generation to complete");
    }
  }
}

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
  const pos = await page.evaluate(() => {
    const turns = [...document.querySelectorAll("ms-chat-turn")];
    const r = turns[turns.length - 1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 40 };
  });
  // Copy button only appears on hover over the response.
  await page.mouse.move(pos.x, pos.y);
  await sleep(1500);
  await page.evaluate(() => {
    const turns = [...document.querySelectorAll("ms-chat-turn")];
    const last = turns[turns.length - 1];
    const btn = [...last.querySelectorAll("button")].find((b) =>
      /open options/i.test(b.getAttribute("aria-label") || b.innerText || ""),
    );
    if (!btn) throw new Error("Open options button not found");
    btn.click();
  });
  await page.waitForSelector("text=Copy as markdown", { timeout: 15000 });
  await page.click("text=Copy as markdown");
  await sleep(1500);
  return page.evaluate(() => navigator.clipboard.readText());
}
