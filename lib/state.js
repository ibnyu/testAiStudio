// Lightweight persistent state: a per-run history log and cumulative counters.
// Both live under the configured state dir (default ./state/, gitignored).
//
// history.jsonl  — one JSON object per processed lecture (append-only)
// counters.json  — running totals shown at the end of each run
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ensureDir = (dir) => mkdirSync(dir, { recursive: true });

export function stateDir(cfg) {
  return (cfg && cfg.history && cfg.history.dir) || "./state";
}

export function historyPath(dir) {
  return join(dir, "history.jsonl");
}
export function countersPath(dir) {
  return join(dir, "counters.json");
}

/** Append one history record. Returns the record for convenience. */
export function appendHistory(dir, entry) {
  ensureDir(dir);
  const record = { at: new Date().toISOString(), ...entry };
  appendFileSync(historyPath(dir), JSON.stringify(record) + "\n");
  return record;
}

/** Read the whole history as an array (oldest first). Missing file -> []. */
export function readHistory(dir) {
  const p = historyPath(dir);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore a torn last line
    }
  }
  return out;
}

/**
 * Most recent status for each lecture name, from history.
 * Returns a Map(name -> { status, at, ... }). Later records win.
 */
export function latestStatusByName(dir) {
  const map = new Map();
  for (const rec of readHistory(dir)) {
    if (rec && rec.name) map.set(rec.name, rec);
  }
  return map;
}

export function defaultCounters() {
  return {
    runs: 0,
    notesOk: 0,
    notesFailed: 0,
    skippedReuse: 0,
    skippedExpired: 0,
    skippedResume: 0,
    chars: 0,
    byModel: {},
    firstAt: null,
    lastAt: null,
  };
}

export function readCounters(dir) {
  const p = countersPath(dir);
  if (!existsSync(p)) return defaultCounters();
  try {
    return { ...defaultCounters(), ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return defaultCounters();
  }
}

export function writeCounters(dir, counters) {
  ensureDir(dir);
  writeFileSync(countersPath(dir), JSON.stringify(counters, null, 2) + "\n");
}

/** Add `delta` to the stored counters and persist; returns the new totals. */
export function bumpCounters(dir, delta = {}) {
  const cur = readCounters(dir);
  const now = new Date().toISOString();
  const next = { ...cur };
  for (const [k, v] of Object.entries(delta)) {
    if (k === "byModel") {
      next.byModel = { ...cur.byModel };
      for (const [m, n] of Object.entries(v)) {
        next.byModel[m] = (next.byModel[m] || 0) + n;
      }
    } else if (typeof v === "number") {
      next[k] = (cur[k] || 0) + v;
    } else {
      next[k] = v;
    }
  }
  next.firstAt = cur.firstAt || now;
  next.lastAt = now;
  writeCounters(dir, next);
  return next;
}
