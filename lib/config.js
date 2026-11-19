// Single source of truth for user-tunable settings.
//
// Precedence (lowest -> highest): built-in defaults < config.json < env vars
// < command-line flags. Scripts call loadConfig() to get the merged object and
// then apply their own CLI overrides on top.
//
// The file lives next to notion.json (./config.json, gitignored). Manage it
// with `bun config.js` rather than editing by hand.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const CONFIG_PATH = process.env.NOTES_CONFIG || "./config.json";

export const DEFAULT_CONFIG = Object.freeze({
  account: "ibny",
  // Optional second account used as a fallback when the primary fails a lecture.
  // Kept for backwards compatibility; `accounts.backups` is the new list form.
  backupAccount: null,
  // Default model. gemini-4-hydrogen is the current general model; "latest-flash"
  // remains available as an opt-in alias that tracks the newest Flash slot.
  model: "gemini-4-hydrogen",
  // Tried in order when the configured model is missing/quota-limited.
  // The configured model is always tried first; these are appended.
  modelFallbacks: [],
  // Multi-account generation policy. Downloads/archive always stay on the
  // primary account; backups only supply a browser profile.
  accounts: {
    strategy: "on-failure", // "on-failure" | "round-robin"
    backups: [],
    rotateModels: true,
  },
  // Long lectures are split by duration, not file size. count = ceil(duration/max).
  chunking: {
    enabled: true,
    maxMinutes: 120,
    ceilingMinutes: 150,
    genTimeoutMin: 20,
    watchdogMin: 26,
    retryAttempts: 2,
    slidesMaxPages: 40,
    slidesMaxMB: 12,
  },
  // Minimum characters for a note to count as real content (UI fragments are
  // often a few hundred chars). Part notes use a lower threshold internally.
  minNoteChars: 400,
  // Tabs generating notes in parallel (1 = sequential). Each lane starts on a
  // different model, because Google's rate limit is per model. 2-3 is the sweet
  // spot; 4 is the cap.
  jobs: 1,
  // null -> each script keeps its own default ("minimize" for batch, "show").
  windowMode: null,
  // Hard cap on a single generation wait. The wait itself is completion-driven
  // (Stop disappears + Run returns, held steady); this is only the absolute
  // ceiling before the lecture is retried/failed. Keep it modest (<=10).
  genTimeoutMin: 10,
  retry: { attempts: 3, baseDelayMs: 5000, maxDelayMs: 60000 },
  archive: { enabled: true, folder: "Classes", bySubject: false },
  reuse: true,
  // Skip lectures whose note already exists locally or in Notion (--force
  // regenerates, --no-resume disables).
  resume: true,
  slides: { enabled: true, root: null },
  notion: { enabled: true },
  // Optional ffmpeg loudness-normalisation pass before upload.
  audioClean: { enabled: false, loudnessTarget: -16 },
  history: { enabled: true, dir: "./state" },
  counters: { enabled: true },
});

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function readRawConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Cannot parse ${path}: ${e.message}`);
  }
}

export function loadConfig(path = CONFIG_PATH) {
  return deepMerge(structuredClone(DEFAULT_CONFIG), readRawConfig(path));
}

export function writeRawConfig(obj, path = CONFIG_PATH) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

/** Get a possibly-nested value via a dotted key ("retry.attempts"). */
export function getPath(obj, dotted, fallback = undefined) {
  let cur = obj;
  for (const part of String(dotted).split(".")) {
    if (!isPlainObject(cur) || !(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur;
}

/** Set a nested value via a dotted key, creating intermediate objects. */
export function setPath(obj, dotted, value) {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** Delete a nested value via a dotted key. Returns true if something was removed. */
export function deletePath(obj, dotted) {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isPlainObject(cur[p])) return false;
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!isPlainObject(cur) || !(last in cur)) return false;
  delete cur[last];
  return true;
}

/** Coerce a CLI string into a JSON value when possible, else keep the string. */
export function parseValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
