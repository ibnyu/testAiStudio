// Duration-based chunking for long lectures.
//
// AI Studio has a practical input/context ceiling and long generations get
// truncated. Instead of splitting by file size (which varies wildly between
// mp3/webm), split by *media duration*:
//
//   count = ceil(duration / maxMinutes)
//   each  = duration / count            (equal-sized parts)
//
// Defaults: 120 minutes per part with a hard 150-minute ceiling. A 210-minute
// lecture becomes two 105-minute parts; a 90-minute lecture stays one part.
//
// Chunk boundaries are deterministic for a given file + config, so a failed
// part can be retried later without re-cutting the media or regenerating the
// parts that already succeeded.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { inspectNote } from "./validate.js";

export const DEFAULT_MAX_MINUTES = 120;
export const DEFAULT_CEILING_MINUTES = 150;

const MEDIA_EXTS = new Set([
  ".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav", ".aac",
  ".mp4", ".webm", ".mkv", ".mov", ".3gp", ".ts",
]);

const run = (cmd) =>
  Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

/** Duration in seconds via ffprobe, or null when the file is unreadable. */
export function probeDuration(file) {
  if (!file || !existsSync(file)) return null;
  const proc = run([
    "ffprobe",
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  if (proc.exitCode === 0) {
    const n = Number(proc.stdout.toString().trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Some containers expose duration only on the stream.
  const proc2 = run([
    "ffprobe",
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  if (proc2.exitCode === 0) {
    const n = Number(proc2.stdout.toString().trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Plan equal-sized chunks. `durationSec` may be null (unknown): callers then
 * treat the media as a single part, because guessing a split is worse than
 * letting AI Studio try the whole file.
 * Returns [{ index, count, start, durationSec }] with 1-based index.
 */
export function planChunks(durationSec, { maxMinutes = DEFAULT_MAX_MINUTES, ceilingMinutes = DEFAULT_CEILING_MINUTES } = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return [{ index: 1, count: 1, start: 0, durationSec: null }];
  }
  const ceiling = Math.max(1, Math.min(Number(maxMinutes) || DEFAULT_MAX_MINUTES, Number(ceilingMinutes) || DEFAULT_CEILING_MINUTES));
  const maxSec = ceiling * 60;
  const count = Math.max(1, Math.ceil(durationSec / maxSec));
  const each = durationSec / count;
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    count,
    start: i * each,
    // Keep full float precision; the final chunk ends exactly at duration.
    durationSec: i === count - 1 ? durationSec - i * each : each,
  }));
}

export function isMediaFile(file) {
  return MEDIA_EXTS.has(extname(String(file || "")).toLowerCase());
}

/**
 * Cut `file` into the planned chunks with ffmpeg stream copy.
 * Returns [{ index, path }]. Existing non-empty outputs are reused, so a
 * crashed run does not re-cut media that was already produced.
 */
export function splitMedia(file, chunks, outDir, { log = () => {} } = {}) {
  if (!chunks || chunks.length <= 1) return [];
  mkdirSync(outDir, { recursive: true });
  const ext = extname(file).toLowerCase() || ".mp3";
  const out = [];
  for (const c of chunks) {
    const dest = join(outDir, `part-${String(c.index).padStart(2, "0")}${ext}`);
    if (existsSync(dest) && statSync(dest).size > 0 && probeDuration(dest) > 0) {
      out.push({ index: c.index, path: dest });
      continue;
    }
    if (existsSync(dest)) unlinkSync(dest);
    const args = [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
      // Input seeking is accurate enough for audio and much faster.
      "-ss", c.start.toFixed(3),
      "-i", file,
      "-t", Math.max(0.5, c.durationSec).toFixed(3),
      "-map", "0",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      dest,
    ];
    log(`splitting part ${c.index}/${c.count} (${Math.round(c.durationSec / 60)} min) ...`);
    const proc = run(args);
    if (proc.exitCode !== 0 || !existsSync(dest) || statSync(dest).size === 0) {
      // Stream copy can fail on some containers; fall back to audio re-encode
      // (the transcript is what the model needs, and it keeps every part small).
      const err = proc.stderr.toString().trim().slice(0, 300);
      log(`stream-copy split failed for part ${c.index} (${err}); re-encoding audio ...`);
      if (existsSync(dest)) unlinkSync(dest);
      const fallback = run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", c.start.toFixed(3), "-i", file,
        "-t", Math.max(0.5, c.durationSec).toFixed(3),
        "-vn", "-c:a", "libmp3lame", "-b:a", "128k",
        dest,
      ]);
      if (fallback.exitCode !== 0 || !existsSync(dest) || statSync(dest).size === 0) {
        throw new Error(`ffmpeg could not split ${basename(file)} part ${c.index}: ${fallback.stderr.toString().trim().slice(0, 300)}`);
      }
    }
    out.push({ index: c.index, path: dest });
  }
  return out;
}

/** Deterministic key for a chunk plan (used to reuse cached parts safely). */
export function planKey(durationSec, cfg = {}) {
  const max = Number(cfg.maxMinutes) || DEFAULT_MAX_MINUTES;
  const ceil = Number(cfg.ceilingMinutes) || DEFAULT_CEILING_MINUTES;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return "single";
  return `${Math.round(durationSec)}s-${Math.min(max, ceil)}m`;
}

/**
 * Cache of successful *part* notes under `<notesDir>/.parts/<noteBase>/`.
 * `manifest.json` records the media duration + chunk config; if either changes,
 * the cache is discarded so stale parts can never be merged into a new note.
 */
export class PartCache {
  constructor({ notesDir, noteBase, durationSec, chunking }) {
    this.noteBase = noteBase;
    this.dir = join(notesDir, ".parts", noteBase);
    this.key = planKey(durationSec, chunking);
    this.durationSec = durationSec;
    this.chunking = chunking || {};
    this.manifestPath = join(this.dir, "manifest.json");
    this.manifest = this.#load();
  }

  #load() {
    const fresh = {
      version: 1,
      noteBase: this.noteBase,
      durationSec: this.durationSec,
      maxMinutes: this.chunking.maxMinutes ?? DEFAULT_MAX_MINUTES,
      ceilingMinutes: this.chunking.ceilingMinutes ?? DEFAULT_CEILING_MINUTES,
      key: this.key,
      parts: {},
    };
    let old = null;
    try {
      old = JSON.parse(readFileSync(this.manifestPath, "utf8"));
    } catch {
      old = null;
    }
    if (old && old.key === this.key && old.version === 1) {
      return { ...fresh, ...old, parts: old.parts || {} };
    }
    // Missing, corrupt, or stale manifest: never trust part files whose
    // boundaries cannot be proven to match this run.
    if (existsSync(this.dir)) {
      for (const f of readdirSync(this.dir)) {
        if (f === "manifest.json") continue;
        try { unlinkSync(join(this.dir, f)); } catch {}
      }
    }
    return fresh;
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2) + "\n");
  }

  partPath(index) {
    return join(this.dir, `part-${String(index).padStart(2, "0")}.md`);
  }

  /** Cached markdown for a part if it exists and still validates. */
  read(index) {
    const p = this.partPath(index);
    if (!existsSync(p)) return null;
    try {
      const text = readFileSync(p, "utf8");
      const check = inspectNote(text, { minChars: 120 });
      if (!check.ok) return null;
      return text;
    } catch {
      return null;
    }
  }

  write(index, markdown, meta = {}) {
    mkdirSync(this.dir, { recursive: true });
    // Written synchronously: the caller deletes the split media right after a
    // part is cached, so the part file must already be on disk.
    writeFileSync(this.partPath(index), markdown);
    this.manifest.parts[index] = {
      chars: markdown.length,
      at: new Date().toISOString(),
      status: "ok",
      ...meta,
    };
    this.save();
  }

  markFailed(index, error) {
    this.manifest.parts[index] = {
      ...(this.manifest.parts[index] || {}),
      status: "failed",
      error: String(error || "").slice(0, 300),
      at: new Date().toISOString(),
    };
    this.save();
  }

  clearPart(index) {
    const p = this.partPath(index);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
    delete this.manifest.parts[index];
    this.save();
  }

  /** Merge cached parts in order; only call after every part is present. */
  merged() {
    const count = Number(this.manifest.count || 0);
    const parts = [];
    for (let i = 1; i <= count; i++) {
      const text = this.read(i);
      if (!text) return null;
      parts.push(text.trim());
    }
    return parts.join("\n\n");
  }
}
