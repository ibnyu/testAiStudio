// Downloader ported from the original `batch-dl` (Python), trimmed to the parts
// the unified pipeline needs: clipboard URL extraction, classification, subject
// routing, and running yt-dlp while capturing the produced media paths.
//
// Source of truth for the flags below is ~/.local/bin/batch-dl.orig.bak.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname } from "node:path";

// ---------------------------------------------------------------- config ----
export const REGISTRY = join(
  homedir(),
  ".cache/clipboard-indicator@tudmotu.com/registry.txt",
);

const IFRAME_COOKIES = join(homedir(), "Downloads/acscookies.txt");
const IFRAME_THREADS = "16";
const IFRAME_REFERER = "https://academic.aparsclassroom.com/";
const IFRAME_ORIGIN = "https://academic.aparsclassroom.com";
const IFRAME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const YOUTUBE_COOKIES = join(homedir(), "Downloads/ytcookie.txt");
const YOUTUBE_THREADS = "8";

export const UPLOAD_EXTS = new Set([
  ".mp3", ".mp4", ".m4a", ".opus", ".webm", ".ogg", ".flac", ".wav",
]);

const IFRAME_RE = /^https:\/\/iframe\.mediadelivery\.net\/embed\/\d+\/[0-9a-fA-F-]{36}\/?$/;
const APARS_M3U8_RE = /^https:\/\/\S*aparsclassroom\S*\.m3u8(\?\S*)?$/i;
const GENERIC_M3U8_RE = /^https?:\/\/\S+\.m3u8(\?\S*)?$/i;
const YOUTUBE_RE = /^https:\/\/(www\.|m\.|music\.)?youtube\.com\/(watch\?v=|shorts\/)[\w-]{11}/;
const YOUTUBE_SHORT_RE = /^https:\/\/youtu\.be\/[\w-]{11}/;

// Subject = filename prefix + output subdir; batch numbering = filename suffix.
const SUBJECT_RULES = [
  ["hbio", "Biology"],
  ["bio", "Biology"],
  ["b2a", "Chemistry"],
  ["chem", "Chemistry"],
  ["b2m", "Physics"],
  ["phy", "Physics"],
  ["b-cdn", "Maths"],
  ["math", "Maths"],
];
const DEFAULT_SUBJECT = "Streams";
// ----------------------------------------------------------------------------

export function isIframe(url) {
  return IFRAME_RE.test(url);
}
export function isM3u8(url) {
  return APARS_M3U8_RE.test(url) || GENERIC_M3U8_RE.test(url);
}
export function isApars(url) {
  return isIframe(url) || isM3u8(url);
}
export function isYoutube(url) {
  return YOUTUBE_RE.test(url) || YOUTUBE_SHORT_RE.test(url);
}

export function subjectForUrl(url) {
  const low = url.toLowerCase();
  for (const [pattern, subject] of SUBJECT_RULES) {
    if (low.includes(pattern)) return subject;
  }
  return DEFAULT_SUBJECT;
}

export function groupAparsBySubject(urls) {
  const grouped = new Map();
  for (const url of urls) {
    const subject = subjectForUrl(url);
    if (!grouped.has(subject)) grouped.set(subject, []);
    grouped.get(subject).push(url);
  }
  return grouped;
}

/** Latest contiguous run of URL entries ending at the newest clipboard entry. */
export function readClipboardUrls() {
  let entries;
  try {
    entries = JSON.parse(readFileSync(REGISTRY, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(`clipboard registry not found: ${REGISTRY}`);
    }
    throw new Error(`cannot parse ${REGISTRY}: ${e.message}`);
  }
  const run = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && typeof entry === "object" && typeof entry.contents === "string") {
      const url = entry.contents.trim();
      if (isApars(url) || isYoutube(url)) run.push(url);
      else if (run.length) break;
    } else if (run.length) break;
  }
  if (!run.length) {
    throw new Error("no iframe, m3u8, or YouTube URLs found in clipboard history");
  }
  run.reverse();
  const seen = new Set();
  const out = [];
  for (const u of run) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export function classify(urls) {
  const kinds = new Set();
  for (const u of urls) {
    if (isIframe(u)) kinds.add("iframe");
    else if (isM3u8(u)) kinds.add("m3u8");
    else if (isYoutube(u)) kinds.add("youtube");
    else kinds.add("other");
  }
  if ([...kinds].every((k) => k === "iframe" || k === "m3u8")) return "iframe";
  if (kinds.size === 1 && kinds.has("youtube")) return "youtube";
  if (kinds.has("other")) {
    const bad = urls.find((u) => !(isApars(u) || isYoutube(u)));
    throw new Error(`unrecognized URL: ${bad}`);
  }
  throw new Error("mixed Apar (iframe/m3u8) and YouTube URLs in batch; run separately");
}

function iframeCmd(urls, dir, template) {
  return [
    "yt-dlp",
    "-P", dir,
    "-o", template,
    "-N", IFRAME_THREADS,
    "--no-part",
    "--no-keep-fragments",
    "--cookies", IFRAME_COOKIES,
    "--no-playlist",
    "-x", "--audio-format", "mp3",
    "--add-header", `Referer: ${IFRAME_REFERER}`,
    "--add-header", `Origin: ${IFRAME_ORIGIN}`,
    "--add-header", `User-Agent: ${IFRAME_USER_AGENT}`,
    "--print", "after_move:filepath",
    ...urls,
  ];
}

function youtubeCmd(urls, dir) {
  return [
    "yt-dlp",
    "-P", dir,
    "--no-playlist",
    "-x", "--audio-format", "mp3",
    "--cookies", YOUTUBE_COOKIES,
    "-N", YOUTUBE_THREADS,
    "--concurrent-fragments", YOUTUBE_THREADS,
    "--print", "after_move:filepath",
    ...urls,
  ];
}

/**
 * Build one yt-dlp command per subject segment. `downloadRoot` receives
 * per-subject subdirectories. Returns [{ label, subject, dir, cmd }].
 */
export function planCommands(kind, urls, downloadRoot) {
  const plans = [];
  if (kind === "iframe") {
    for (const [subject, group] of groupAparsBySubject(urls)) {
      const dir = join(downloadRoot, subject);
      const template = `${subject}_%(id)s_%(autonumber)02d.%(ext)s`;
      plans.push({ label: subject, subject, dir, cmd: iframeCmd(group, dir, template) });
    }
    return plans;
  }
  const dir = join(downloadRoot, "YouTube");
  plans.push({ label: "youtube", subject: "YouTube", dir, cmd: youtubeCmd(urls, dir) });
  return plans;
}

/**
 * Run a yt-dlp command, streaming output live, and collect the produced media
 * file paths printed via `--print after_move:filepath`.
 */
export async function runPlan(plan) {
  const proc = Bun.spawn(plan.cmd, { stdout: "pipe", stderr: "inherit" });
  const decoder = new TextDecoder();
  let buf = "";
  const paths = [];
  for await (const chunk of proc.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    process.stdout.write(text);
    buf += text;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line && UPLOAD_EXTS.has(extname(line).toLowerCase()) && existsSync(line)) {
        paths.push(line);
      }
    }
  }
  await proc.exited;
  return { code: proc.exitCode, paths: [...new Set(paths)] };
}
