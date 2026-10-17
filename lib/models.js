// AI Studio model selection.
//
// The model is chosen with the `?model=<slug>` URL parameter, e.g.
//   https://aistudio.google.com/prompts/new_chat?model=gemini-3.8-flash
// The special value "latest-flash" (the default) instead reads the live model
// picker and selects the newest plain Flash model, so the pipeline tracks new
// releases without code changes.
//
// Selectors below were verified live against the site (Google AI Studio,
// 2026-10-17):
//   - the picker button:  button.model-selector-card
//   - the open drawer:    .cdk-overlay-pane  (rows: name, then "gemini-x.y-slug")
//   - the current model:  ms-model-selector .subtitle
const BASE = "https://aistudio.google.com/prompts/new_chat";

export const DEFAULT_MODEL = "gemini-3.8-flash";
export const LATEST_FLASH = "latest-flash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL for a new chat pinned to `model` (or the site default when omitted). */
export function newChatUrl(model) {
  return model && model !== LATEST_FLASH
    ? `${BASE}?model=${encodeURIComponent(model)}`
    : BASE;
}

/** Slug of the model currently shown in the picker (e.g. "gemini-3.8-flash"). */
export async function currentModelSlug(page) {
  try {
    const slug = await page.evaluate(() => {
      const el = document.querySelector("ms-model-selector .subtitle");
      return el ? el.textContent.trim() : null;
    });
    return slug || null;
  } catch {
    return null;
  }
}

function parseModels(text) {
  const lines = String(text)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  let name = null;
  for (const line of lines) {
    const m = line.match(/\b(gem(?:ini|ma)-[a-z0-9.]+)\b/i);
    if (m) {
      const slug = m[1].toLowerCase();
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name: name || slug, slug });
      }
      name = null;
      continue;
    }
    if (/^(Gemini|Gemma|Imagen|Veo|Nano|Lyria)\b/i.test(line)) name = line;
  }
  return out;
}

/**
 * Open the model picker and return [{ name, slug }]. Best-effort: returns [] if
 * the picker cannot be read, so callers can fall back to a pinned slug.
 */
export async function discoverModels(page, { waitMs = 1500 } = {}) {
  const button = "button.model-selector-card";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.waitForSelector(button, { timeout: 20000 });
      await page.click(button);
      // The drawer renders asynchronously as a CDK overlay.
      await page
        .waitForSelector(".cdk-overlay-pane", { timeout: 8000 })
        .catch(() => {});
      await sleep(waitMs);
      const text = await page.evaluate(() => {
        const pane =
          document.querySelector(".cdk-overlay-pane") ||
          document.querySelector("ms-model-selector");
        return pane ? pane.innerText : "";
      });
      const models = parseModels(text);
      if (models.length) {
        await page.keyboard.press("Escape").catch(() => {});
        return models;
      }
      if (text) console.error(`[models] picker text present but unparsed (${text.length} chars)`);
      await page.keyboard.press("Escape").catch(() => {});
    } catch {
      // retry once
    }
  }
  return [];
}

const version = (slug) => {
  const m = slug.match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
};

/**
 * Newest plain Flash model (excludes lite / tts / live / translate / audio /
 * image variants). Returns null when none match.
 */
export function pickLatestFlash(models) {
  const flashes = (models || []).filter(
    (m) =>
      /-flash$/i.test(m.slug) &&
      !/lite|tts|live|translate|audio|image|nano|robotics|omni/i.test(m.slug),
  );
  if (!flashes.length) return null;
  flashes.sort((a, b) => {
    const [amaj, amin] = version(a.slug);
    const [bmaj, bmin] = version(b.slug);
    if (bmaj !== amaj) return bmaj - amaj;
    if (bmin !== amin) return bmin - amin;
    // Prefer a stable slug over a "preview" of the same version.
    return (/preview/i.test(a.slug) ? 1 : 0) - (/preview/i.test(b.slug) ? 1 : 0);
  });
  return flashes[0];
}

/**
 * Resolve the configured model to a concrete slug. Concrete slugs pass through
 * unchanged; "latest-flash" reads the live picker. Falls back to DEFAULT_MODEL.
 * Returns { slug, source }.
 */
export async function resolveModel(page, wanted) {
  const requested = wanted || LATEST_FLASH;
  if (requested !== LATEST_FLASH) {
    return { slug: requested, source: "configured" };
  }
  const models = await discoverModels(page);
  const pick = pickLatestFlash(models);
  if (pick) return { slug: pick.slug, source: `latest-flash (${pick.name})` };
  return { slug: DEFAULT_MODEL, source: "fallback (picker unreadable)" };
}
