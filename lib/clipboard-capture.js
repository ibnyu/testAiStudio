// Capture, inside the page, the text AI Studio copies.
//
// CloakBrowser's stealth Chromium can report a successful
// `navigator.clipboard.writeText()` while the OS clipboard keeps its previous
// contents (verified repeatedly with `xclip`/`wl-paste` on Wayland). Waiting for
// the OS clipboard to change therefore produced stale text, empty notes, or a
// fall back to the rendered DOM. This module patches the clipboard API and the
// `copy` event so the exact Markdown the site emits is kept on
// `window.__zsClipboard`, independent of the desktop clipboard.
//
// The script must be installed before the page navigates (context.addInitScript
// in lib/browser.js covers every tab of every profile).

export const CAPTURE_KEY = "__zsClipboard";
export const EMPTY_CAPTURE = { text: "", seq: 0, at: 0, source: "" };

/**
 * Init script source. Installed via `context.addInitScript(script)`; string form
 * so no bundler/function-serialization assumptions are involved.
 */
export function clipboardCaptureScript() {
  return `(() => {
  const KEY = ${JSON.stringify(CAPTURE_KEY)};
  if (window[KEY]) return;
  const state = { text: "", seq: 0, at: 0, source: "" };
  window[KEY] = state;
  const record = (text, source) => {
    if (typeof text !== "string" || !text) return;
    state.text = text;
    state.seq += 1;
    state.at = Date.now();
    state.source = source;
  };

  // navigator.clipboard.writeText (Angular CDK and most modern copy buttons).
  try {
    const proto =
      (window.Clipboard && window.Clipboard.prototype) ||
      Object.getPrototypeOf(navigator.clipboard);
    if (proto && typeof proto.writeText === "function") {
      const orig = proto.writeText;
      proto.writeText = function (text) {
        record(text, "writeText");
        return orig.apply(this, arguments);
      };
    }
  } catch {}

  // ClipboardItem-based writes: pull the text/plain blob out synchronously if
  // the blob exposes one; never block or alter the real write.
  try {
    const proto = window.Clipboard && window.Clipboard.prototype;
    if (proto && typeof proto.write === "function") {
      const orig = proto.write;
      proto.write = function (items) {
        try {
          for (const item of items || []) {
            for (const type of item.types || []) {
              if (type !== "text/plain") continue;
              const blob = item.getType(type);
              if (blob && typeof blob.text === "function") {
                blob.text().then((t) => record(t, "write")).catch(() => {});
              }
            }
          }
        } catch {}
        return orig.apply(this, arguments);
      };
    }
  } catch {}

  // document.execCommand("copy"): AI Studio (Angular CDK) writes a hidden
  // textarea, selects it, then copies. At that moment the payload is the
  // active element's value, so capture it before delegating.
  try {
    const doc = window.document;
    if (typeof doc.execCommand === "function") {
      const orig = doc.execCommand;
      doc.execCommand = function (command) {
        if (/^copy$/i.test(String(command))) {
          try {
            const el = doc.activeElement;
            const value = el && typeof el.value === "string" ? el.value : "";
            const selection = String(window.getSelection() || "");
            const text = value || selection;
            if (text) record(text, "execCommand");
          } catch {}
        }
        return orig.apply(doc, arguments);
      };
    }
  } catch {}

  // document.execCommand("copy") and the legacy textarea fallback both fire a
  // copy event carrying the payload (when it is set by a handler rather than a
  // selected textarea).
  try {
    window.addEventListener(
      "copy",
      (e) => {
        try {
          const data = e.clipboardData;
          record(data ? data.getData("text/plain") : "", "copy-event");
        } catch {}
      },
      true,
    );
  } catch {}
})();`;
}

/** Install the capture script on a context (all current and future pages). */
export async function installClipboardCapture(context) {
  if (!context?.addInitScript) return;
  await context.addInitScript(clipboardCaptureScript());
}

/** Read the last text the page copied, as `{ text, seq, at, source }`. */
export async function readCapturedClipboard(page) {
  try {
    return await page.evaluate((key) => {
      const s = window[key];
      return s
        ? { text: s.text, seq: s.seq, at: s.at, source: s.source }
        : { text: "", seq: 0, at: 0, source: "" };
    }, CAPTURE_KEY);
  } catch {
    return { ...EMPTY_CAPTURE };
  }
}
