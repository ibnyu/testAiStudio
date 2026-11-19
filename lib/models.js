// AI Studio model selection.
//
// The model is chosen with the `?model=<slug>` URL parameter, e.g.
//   https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen
// The special value "latest-flash" instead reads the live model picker and
// selects the newest plain Flash model, so the pipeline tracks new releases
// without code changes. The *default* is pinned to gemini-4-hydrogen.
//
// Selectors verified live against Google AI Studio (2026-10):
//   - picker button:   button.model-selector-card
//   - open drawer:     .cdk-overlay-pane
//   - row:             [id="model-carousel-row-models/<slug>"]
//   - alias detail:    li[data-test-model-alias-line-item-detail]
//                      (e.g. "Points to gemini-3.8-flash")
//   - current model:   ms-model-selector .subtitle
//
// The old parser captured only `gemini-3` from `gemini-3.8-flash` because its
// regex stopped at the first dash. It now reads the full slug from each row's
// DOM id, with a text fallback that accepts the complete slug.
import { ModelUnavailableError } from "./errors.js";

const BASE = "https://aistudio.google.com/prompts/new_chat";

export const DEFAULT_MODEL = "gemini-4-hydrogen";
export const LATEST_FLASH = "latest-flash";
export const FLASH_ALIAS = "gemini-flash-latest";

// Practical fallback chain when a model is unavailable/misconfigured. The
// configured model is always tried first; these are appended after it.
export const DEFAULT_MODEL_FALLBACKS = [DEFAULT_MODEL, "gemini-3.8-flash", FLASH_ALIAS];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL for a new chat pinned to `model` (or the site default when omitted). */
export function newChatUrl(model) {
  return model && model !== LATEST_FLASH
    ? `${BASE}?model=${encodeURIComponent(model)}`
    : BASE;
}

const FULL_SLUG_RE = /\b((?:gemini|gemma|imagen|veo|lyria|nano)[a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+)\b/i;

/** Extract a full model slug from arbitrary picker/button text. */
export function slugFromText(text) {
  const m = String(text || "").match(FULL_SLUG_RE);
  return m ? m[1].toLowerCase() : null;
}

/** Slug of the model currently shown in the picker, or null. */
export async function currentModelSlug(page) {
  try {
    return await page.evaluate(() => {
      const candidates = [
        "ms-model-selector .subtitle",
        "ms-model-selector .model-name",
        "button.model-selector-card .subtitle",
        "button.model-selector-card",
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        const text = el ? (el.innerText || el.textContent || "").trim() : "";
        const m = text.match(/\b((?:gemini|gemma|imagen|veo|lyria|nano)[a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+)\b/i);
        if (m) return m[1].toLowerCase();
      }
      return null;
    });
  } catch {
    return null;
  }
}

/** Text of any visible warning banner about the model selection. */
export async function modelWarning(page) {
  try {
    return await page.evaluate(() => {
      const re = /(specified model (?:was )?not (?:recognized|found)|default model will be used|model (?:could not be found|is not available)|invalid model)/i;
      const nodes = [
        ...document.querySelectorAll(
          "[role=alert], mat-snack-bar-container, .mat-mdc-snack-bar-label, [aria-live=assertive], .error, .warning",
        ),
      ];
      for (const n of nodes) {
        const t = (n.innerText || n.textContent || "").trim();
        if (t && re.test(t)) return t.slice(0, 300);
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Read the picker rows from the DOM. Each row yields
 * `{ name, slug, aliasOf }`; aliases (e.g. gemini-flash-latest) report the
 * concrete model they point at.
 */
async function readModelRows(page) {
  return page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const slugRe = /\b((?:gemini|gemma|imagen|veo|lyria|nano)[a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+)\b/i;

    const add = (slug, name, aliasOf = null) => {
      const s = String(slug || "").toLowerCase();
      if (!s || seen.has(s)) return;
      seen.add(s);
      rows.push({ slug: s, name: (name || s).trim(), aliasOf });
    };

    // Preferred: row ids carry the exact slug.
    for (const row of document.querySelectorAll('[id^="model-carousel-row-models/"]')) {
      const slug = row.id.slice("model-carousel-row-models/".length).replace(/^models\//, "").trim();
      if (!slug) continue;
      const text = (row.innerText || row.textContent || "").trim();
      const first = text.split("\n").map((s) => s.trim()).filter(Boolean)[0] || slug;
      const detail = row.querySelector("[data-test-model-alias-line-item-detail]");
      const detailText = detail ? (detail.innerText || detail.textContent || "") : "";
      const aliasMatch = detailText.match(slugRe);
      add(slug, first, aliasMatch ? aliasMatch[1].toLowerCase() : null);
    }

    // Fallback: parse the drawer text if row ids are unavailable.
    if (!rows.length) {
      const pane = document.querySelector(".cdk-overlay-pane") || document.querySelector("ms-model-selector");
      const text = pane ? (pane.innerText || "") : "";
      let name = null;
      for (const line of text.split("\n").map((s) => s.trim()).filter(Boolean)) {
        const m = line.match(slugRe);
        if (m) {
          add(m[1], name || m[1]);
          name = null;
        } else if (/^(Gemini|Gemma|Imagen|Veo|Nano|Lyria)\b/i.test(line)) {
          name = line;
        }
      }
    }
    return rows;
  });
}

/**
 * Open the model picker and return [{ name, slug, aliasOf }]. Best-effort:
 * returns [] if the picker cannot be read, so callers can fall back to a pinned
 * slug and let post-navigation verification catch a bad selection.
 */
export async function discoverModels(page, { waitMs = 1200 } = {}) {
  const button = "button.model-selector-card";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.waitForSelector(button, { timeout: 20000 });
      await page.click(button);
      await page.waitForSelector(".cdk-overlay-pane", { timeout: 8000 }).catch(() => {});
      await sleep(waitMs);
      const models = await readModelRows(page);
      await page.keyboard.press("Escape").catch(() => {});
      if (models.length) return models;
    } catch {
      // retry once
    }
  }
  return [];
}

export const version = (slug) => {
  const m = String(slug || "").match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
};

const EXCLUDED_VARIANT = /lite|tts|live|translate|audio|image|nano|robotics|omni|embedding|aqa/i;

/** Resolve an alias row to its concrete target, when known. */
export function concreteOf(model) {
  if (!model) return null;
  return model.aliasOf || model.slug;
}

/**
 * Newest plain Flash model (excludes lite/tts/live/... variants). Aliases are
 * resolved to the model they point at. Returns a `{ slug, name, aliasOf }`
 * entry or null.
 */
export function pickLatestFlash(models) {
  const list = [];
  for (const m of models || []) {
    if (!m || !m.slug) continue;
    if (m.slug === FLASH_ALIAS && m.aliasOf) {
      list.push({ ...m, slug: m.aliasOf, aliasOf: null, name: `${m.name} -> ${m.aliasOf}` });
      continue;
    }
    if (!/-flash$/i.test(m.slug)) continue;
    if (EXCLUDED_VARIANT.test(m.slug)) continue;
    list.push({ ...m });
  }
  if (!list.length) return null;
  list.sort((a, b) => {
    const [amaj, amin] = version(a.slug);
    const [bmaj, bmin] = version(b.slug);
    if (bmaj !== amaj) return bmaj - amaj;
    if (bmin !== amin) return bmin - amin;
    // Prefer a stable slug over a "preview" of the same version.
    return (/preview/i.test(a.slug) ? 1 : 0) - (/preview/i.test(b.slug) ? 1 : 0);
  });
  return list[0];
}

/** True when `slug` looks like a concrete model id (not "latest-flash"). */
export function isConcreteSlug(slug) {
  return Boolean(slug && slug !== LATEST_FLASH && FULL_SLUG_RE.test(slug));
}

/**
 * Resolve the configured model to a concrete slug.
 * - concrete slugs are validated against the live picker when it is readable;
 *   an unknown slug falls back to DEFAULT_MODEL instead of silently letting the
 *   site choose its default.
 * - "latest-flash" prefers the `gemini-flash-latest` alias target, then the
 *   newest plain Flash row, then DEFAULT_MODEL.
 *
 * Returns { slug, source, models, fellBack }.
 */
export async function resolveModel(page, wanted) {
  const requested = wanted || DEFAULT_MODEL;
  const models = await discoverModels(page);
  if (requested !== LATEST_FLASH) {
    if (!models.length) {
      return { slug: requested, source: "configured (picker unreadable)", models, fellBack: false };
    }
    const hit = models.find((m) => m.slug === requested);
    if (hit) return { slug: requested, source: "configured", models, fellBack: false };
    return {
      slug: DEFAULT_MODEL,
      source: `fallback (unknown model "${requested}")`,
      models,
      fellBack: true,
    };
  }

  const alias = models.find((m) => m.slug === FLASH_ALIAS);
  if (alias && alias.aliasOf) {
    return { slug: alias.aliasOf, source: `latest-flash alias (${FLASH_ALIAS})`, models, fellBack: false };
  }
  const pick = pickLatestFlash(models);
  if (pick) return { slug: pick.slug, source: `latest-flash (${pick.name})`, models, fellBack: false };
  return { slug: DEFAULT_MODEL, source: "fallback (picker unreadable)", models, fellBack: true };
}

/**
 * Confirm the page really selected `expected`. Throws ModelUnavailableError
 * when the site shows its "specified model was not recognized / default model
 * will be used" warning, or when the picker clearly shows another slug.
 */
export async function verifyModel(page, expected) {
  if (!expected || expected === LATEST_FLASH) return null;
  const warning = await modelWarning(page);
  if (warning) throw new ModelUnavailableError(warning);
  const current = await currentModelSlug(page);
  if (current && current !== expected) {
    // Aliases legitimately resolve to a different concrete slug; the caller
    // passes the resolved slug, so a mismatch here is a real failure.
    throw new ModelUnavailableError(
      `AI Studio selected "${current}" instead of requested "${expected}".`,
    );
  }
  return current;
}

/** Deduplicate and order the model fallback chain for a run. */
export function modelChain(configured, configuredFallbacks = []) {
  const chain = [configured || DEFAULT_MODEL, ...(configuredFallbacks || []), ...DEFAULT_MODEL_FALLBACKS];
  const out = [];
  const seen = new Set();
  for (const m of chain) {
    const v = String(m || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
