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

/**
 * Epoch-seconds expiry of a time-limited signed URL (Apars CDN links carry
 * `?exp=<secs>&sig=...`), or null when the URL is not signed/expiring. These
 * links go dead within a known window, so callers should download them before
 * long-lived work (YouTube downloads, note generation) and warn when stale.
 */
export function urlExpiry(url) {
  const m = /[?&]exp=(\d{9,})/.exec(url);
  return m ? Number(m[1]) : null;
}

export function subjectForUrl(url) {
  const low = url.toLowerCase();
  for (const [pattern, subject] of SUBJECT_RULES) {
    if (low.includes(pattern)) return subject;
  }
  return DEFAULT_SUBJECT;
}

// ------------------------------------------------------------- naming -------
// A "name clip" is a non-URL line the user copies just before a run of URLs:
//   Subject Instructor Paper Chapter   e.g. "Phy Udv P2 Ch4", "HM Udv P2 Ch4"
// (the Subject is simply the first word -- Phy, Chem, Bio, HM, Math, ...).
// The lecture number is NOT part of the clip; it is generated 01..N per run and
// joined with a space so it never merges with the chapter (-> "Phy Udv P2 Ch4 01").
// If the clip itself ends in a bare number (e.g. "Phy Udv P2 Ch4 04") that number
// is treated as the starting index instead of 01.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const NAME_CLIP_RE = /^[A-Za-z]+\s+\S/;

export function isNameClip(text) {
  if (!text || URL_SCHEME_RE.test(text)) return false;
  return NAME_CLIP_RE.test(text.trim());
}

export function splitNameClip(clip) {
  const m = clip.trim().match(/^(.+?)\s+(\d{1,3})$/);
  if (m) return { base: m[1], start: Number(m[2]) };
  return { base: clip.trim(), start: 1 };
}

export function nameForIndex(base, index, start = 1) {
  return `${base} ${String(start + index).padStart(2, "0")}`;
}

/** Split clipboard/file lines (copy order) into [{ name, urls }] groups. */
export function parseGroups(lines) {
  const groups = [];
  let current = { name: null, urls: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (isApars(line) || isYoutube(line)) current.urls.push(line);
    else if (isNameClip(line)) {
      if (current.urls.length) groups.push(current);
      current = { name: line, urls: [] };
    }
  }
  if (current.urls.length) groups.push(current);
  return groups;
}

/** Flatten groups into ordered [{ url, name, clip, index }], assigning 01..N per clip. */
export function expandGroups(groups) {
  const items = [];
  const seen = new Set();
  for (const g of groups) {
    const { base, start } = g.name ? splitNameClip(g.name) : { base: null };
    g.urls.forEach((url, i) => {
      if (seen.has(url)) return;
      seen.add(url);
      items.push({
        url,
        name: base ? nameForIndex(base, i, start) : null,
        clip: base,
        index: start + i,
      });
    });
  }
  return items;
}

/** Newest contiguous clipboard run of URLs and name clips, in copy order. */
export function readClipboardRun() {
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
    const text =
      entry && typeof entry === "object" && typeof entry.contents === "string"
        ? entry.contents.trim()
        : null;
    const isUrl = text && (isApars(text) || isYoutube(text));
    const isName = text && !isUrl && isNameClip(text);
    if (isUrl || isName) run.push(text);
    else if (run.length) break;
  }
  run.reverse();
  return run;
}

export function readClipboardGroups() {
  const groups = parseGroups(readClipboardRun());
  if (!groups.some((g) => g.urls.length)) {
    throw new Error("no iframe, m3u8, or YouTube URLs found in clipboard history");
  }
  return groups;
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

function youtubeCmd(urls, dir, template) {
  return [
    "yt-dlp",
    "-P", dir,
    ...(template ? ["-o", template] : []),
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
 * Build yt-dlp commands. `meta` maps a URL to { name, clip, index }; named URLs
 * download one-at-a-time as "<name>.<ext>" so the archived file, the note file,
 * and the Notion page all share the exact lecture name. Unnamed URLs keep the
 * original subject-grouped templates. Returns
 * [{ label, subject, dir, name, clip, index, cmd }].
 */
export function planCommands(urls, downloadRoot, meta = new Map()) {
  const plans = [];
  const unnamed = [];
  for (const url of urls) {
    const m = meta.get(url);
    if (!m || !m.name) {
      unnamed.push(url);
      continue;
    }
    const isYt = isYoutube(url);
    const subject = isYt ? "YouTube" : subjectForUrl(url);
    const dir = join(downloadRoot, subject);
    const cmd = isYt
      ? youtubeCmd([url], dir, `${m.name}.%(ext)s`)
      : iframeCmd([url], dir, `${m.name}.%(ext)s`);
    plans.push({ label: m.name, subject, dir, name: m.name, clip: m.clip, index: m.index, cmd, urgent: !isYt });
  }
  if (!unnamed.length) return plans;

  const kind = classify(unnamed);
  if (kind === "iframe") {
    for (const [subject, group] of groupAparsBySubject(unnamed)) {
      const dir = join(downloadRoot, subject);
      const template = `${subject}_%(id)s_%(autonumber)02d.%(ext)s`;
      plans.push({
        label: subject,
        subject,
        dir,
        name: null,
        clip: null,
        index: null,
        cmd: iframeCmd(group, dir, template),
        urgent: true,
      });
    }
    return plans;
  }
  const dir = join(downloadRoot, "YouTube");
  plans.push({
    label: "youtube",
    subject: "YouTube",
    dir,
    name: null,
    clip: null,
    index: null,
    cmd: youtubeCmd(unnamed, dir),
    urgent: false,
  });
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
