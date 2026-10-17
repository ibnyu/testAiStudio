// Optional ffmpeg loudness-normalisation pass. Uploading a level-consistent
// track can improve the model's transcription of quiet lectures. Best-effort:
// any failure returns null and the caller keeps using the original file.
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export function ffmpegAvailable() {
  const proc = Bun.spawnSync(["ffmpeg", "-version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

/**
 * Produce "<name>.clean.mp3" with EBU R128 loudness normalisation.
 * Returns the new path on success, or null (caller keeps the original).
 */
export function cleanAudio(src, { target = -16, log = () => {} } = {}) {
  if (!existsSync(src)) return null;
  const out = join(dirname(src), basename(src, extname(src)) + ".clean.mp3");
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", src,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11`,
    "-c:a", "libmp3lame",
    "-q:a", "2",
    out,
  ];
  const proc = Bun.spawnSync(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0 || !existsSync(out)) {
    const err = proc.stderr ? proc.stderr.toString().trim().slice(0, 200) : "ffmpeg failed";
    log(`audio clean skipped: ${err}`);
    return null;
  }
  return out;
}
