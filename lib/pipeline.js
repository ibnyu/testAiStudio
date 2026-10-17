// Shared note pipeline used by main.js (single file) and batch.js (URL batch).
// Keeps the browser flow, upload/link helpers, and note saving in one place.
import { existsSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import {
  assertBrowserProfile,
  rcloneArgs,
  getRemoteSize,
} from "./account.js";
import { launchNoteBrowser, closeNoteBrowser } from "./browser.js";
import {
  gotoNewChat,
  setSystemInstructions,
  runPrompt,
  attachDriveLink,
  waitForAttachmentsReady,
  waitForDone,
  copyLatestResponseMarkdown,
  withTimeout,
} from "./aistudio.js";
import {
  LATEST_FLASH,
  currentModelSlug,
  newChatUrl,
  resolveModel,
} from "./models.js";
import { backoffDelay } from "./retry.js";
import { loadNotionConfig, pushNoteToNotion } from "./notion.js";

const SYS_FILE = "./system_instructions.md";

// A real generated note is thousands of chars. Anything below this means the
// site's "copy as markdown" silently failed (stale/empty clipboard).
const MIN_NOTE_CHARS = 200;

// Window modes for the (headed) automation browser:
//   "minimize" -> launch headed, then minimize the window via CDP
//   "tile"     -> launch headed as a small window in the corner
//   "show"     -> launch headed, leave it where the WM puts it
//   "headless" -> no window at all
export const WINDOW_MODES = new Set(["minimize", "tile", "show", "headless"]);

export async function readSystemInstructions() {
  if (!existsSync(SYS_FILE)) {
    await Bun.write(SYS_FILE, "You are a helpful study assistant.\n");
    throw new Error(`Created ${SYS_FILE} with a default. Edit it, then re-run.`);
  }
  const sysText = (await Bun.file(SYS_FILE).text()).trim();
  if (!sysText) {
    throw new Error(`${SYS_FILE} is empty. Put the system instructions in it.`);
  }
  return sysText;
}

/**
 * Upload a local file to the account's Drive remote and return a public link.
 * `asName` overrides the remote filename (used to give the slide PDF the same
 * base name as its audio). Reuses an existing byte-identical remote copy (dedup).
 */
export function uploadAndLink(acct, localFile, remotePath = "uploads/", asName = null) {
  const fileName = asName || basename(localFile);
  const dest = `${acct.rcloneRemote}${remotePath.replace(/\/$/, "")}/${fileName}`;
  const localSize = Bun.file(localFile).size;
  const remoteSize = getRemoteSize(acct.rcloneConfig, dest);
  if (remoteSize !== null && remoteSize === localSize) {
    console.log(
      `[${acct.account}] Already in Drive: ${dest} (${localSize} bytes match). Skipping upload.`,
    );
  } else {
    if (remoteSize !== null) {
      console.log(
        `[${acct.account}] Drive copy differs (remote ${remoteSize} vs local ${localSize} bytes). Re-uploading.`,
      );
    }
    console.log(`[${acct.account}] Uploading ${localFile} -> ${dest}`);
    const upload = Bun.spawnSync(
      ["rclone", ...rcloneArgs(acct.rcloneConfig, "copyto", localFile, dest)],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (upload.exitCode !== 0) {
      throw new Error(`rclone copyto failed: ${upload.stderr.toString().trim()}`);
    }
  }
  const publicUrl = remoteLink(acct, dest);
  console.log(`[${acct.account}] Public link: ${publicUrl}`);
  return { dest, publicUrl };
}

/** `rclone link` for an existing remote file -> public URL. */
export function remoteLink(acct, dest) {
  const link = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "link", dest)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (link.exitCode !== 0) {
    throw new Error(`rclone link failed: ${link.stderr.toString().trim()}`);
  }
  return link.stdout.toString().trim();
}

// Media extensions an archived lecture may carry. `.pdf` is deliberately
// excluded so a slide PDF never shadows the lecture audio during reuse.
export const ARCHIVE_MEDIA_EXTS = new Set([
  ".mp3", ".m4a", ".opus", ".aac", ".ogg", ".wav", ".flac",
  ".webm", ".mkv", ".mp4", ".mov", ".3gp", ".ts",
]);

/**
 * List media files directly under a Drive folder as a Map of filename stem
 * (extension stripped) -> full remote path, so a named lecture can be matched
 * to the copy a previous run already archived. Returns an empty Map when the
 * folder does not exist yet.
 */
export function listArchivedMedia(acct, remotePath) {
  const dir = `${acct.rcloneRemote}${remotePath.replace(/\/$/, "")}`;
  const proc = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "lsf", "--files-only", `${dir}/`)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const map = new Map();
  if (proc.exitCode !== 0) return map;
  for (const line of proc.stdout.toString().split("\n")) {
    const f = line.trim();
    if (!f) continue;
    const ext = extname(f).toLowerCase();
    if (!ARCHIVE_MEDIA_EXTS.has(ext)) continue;
    map.set(basename(f, ext), `${dir}/${f}`);
  }
  return map;
}

export function removeRemote(acct, dest) {
  const del = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "delete", dest)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (del.exitCode !== 0) {
    console.log(
      `[${acct.account}] WARNING: Drive cleanup failed for ${dest}: ${del.stderr.toString().trim()}`,
    );
  } else {
    console.log(`[${acct.account}] Removed Drive file: ${dest}`);
  }
}

async function minimizeWindow(page) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
  } catch {
    // Non-fatal: some WMs/platforms refuse programmatic minimize.
  }
}

/**
 * Run the AI Studio chat flow against one or more already-public file URLs
 * (audio first, then its slide PDF) and save the notes to
 * <notesDir>/<noteBaseName without ext>.md.
 * Retries transient Google-side flakes with a fresh browser (up to 3 tries).
 */
export async function generateNoteFromUrl({
  acct,
  publicUrl,
  publicUrls,
  noteBaseName,
  sysText,
  windowMode = "show",
  model = LATEST_FLASH,
  genTimeoutMs = 60 * 60 * 1000,
  retry = { attempts: 3, baseDelayMs: 5000, maxDelayMs: 60000 },
  notesDir = "./notes",
}) {
  const urls = publicUrls && publicUrls.length ? publicUrls : [publicUrl];
  if (!urls[0]) throw new Error("generateNoteFromUrl needs publicUrl or publicUrls");
  if (!WINDOW_MODES.has(windowMode)) {
    throw new Error(`Unknown window mode "${windowMode}" (use: ${[...WINDOW_MODES].join(", ")})`);
  }
  const headless = windowMode === "headless";
  const launchArgs =
    windowMode === "tile"
      ? ["--window-size=1100,720", "--window-position=0,0"]
      : undefined;

  const MAX_ATTEMPTS = retry?.attempts > 0 ? retry.attempts : 3;
  let markdown = null;
  let usedModel = model;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let context = null;
    try {
      console.log(
        `[${acct.account}] Browser attempt ${attempt}/${MAX_ATTEMPTS} (${windowMode}) ...`,
      );
      // launchNoteBrowser reaps any ghost Chromium holding the profile first,
      // and retries once itself if the profile is still locked.
      context = await launchNoteBrowser({
        userDataDir: acct.userDataDir,
        headless,
        args: launchArgs,
      });
      await withTimeout(
        context.grantPermissions(["clipboard-read", "clipboard-write"]),
        30000,
        "grantPermissions timed out",
      ).catch((e) => console.log(`[${acct.account}] warning: ${e.message}`));
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(30000);
      if (windowMode === "minimize") await minimizeWindow(page);

      // Pick the model: a concrete slug is used as-is; "latest-flash" reads the
      // live picker and re-navigates only if the site default differs.
      let modelSlug = model;
      if (model === LATEST_FLASH) {
        await withTimeout(gotoNewChat(page), 60000, "gotoNewChat timed out");
        const { slug, source } = await resolveModel(page, model);
        modelSlug = slug;
        if ((await currentModelSlug(page)) !== slug) {
          await withTimeout(gotoNewChat(page, slug), 60000, "gotoNewChat(model) timed out");
        }
        console.log(`[${acct.account}] Model: ${modelSlug} (${source})`);
      } else {
        await withTimeout(gotoNewChat(page, model), 60000, "gotoNewChat timed out");
        console.log(`[${acct.account}] Model: ${modelSlug}`);
      }
      usedModel = modelSlug;
      console.log(`[${acct.account}] New chat: ${newChatUrl(modelSlug)}`);

      await withTimeout(
        setSystemInstructions(page, sysText),
        90000,
        "setSystemInstructions timed out",
      );
      console.log(`[${acct.account}] System instructions set from ${SYS_FILE}.`);

      const pasteMethods = [];
      for (const [idx, u] of urls.entries()) {
        const method = await withTimeout(
          attachDriveLink(page, u),
          90000,
          `attach file ${idx + 1} timed out`,
        );
        pasteMethods.push(method);
        console.log(
          `[${acct.account}] Attached file ${idx + 1}/${urls.length} (via ${method}).`,
        );
      }
      console.log(`[${acct.account}] Waiting for ${urls.length} file(s) to load...`);
      const chip = await waitForAttachmentsReady(page, urls.length);
      console.log(`[${acct.account}] Files loaded: ${chip.text}`);

      await withTimeout(runPrompt(page), 90000, "runPrompt timed out");
      console.log(
        `[${acct.account}] Prompt sent (file attached). Waiting for generation (timeout ${Math.round(genTimeoutMs / 60000)} min)...`,
      );
      await waitForDone(page, {
        timeoutMs: genTimeoutMs,
        onProgress: ({ elapsedMs, len, stop }) =>
          console.log(
            `[${acct.account}] ...generating ${Math.round(elapsedMs / 1000)}s ` +
              `(${len} chars, ${stop ? "running" : "idle"})`,
          ),
      });
      console.log(`[${acct.account}] Generation complete. Copying markdown...`);
      markdown = await withTimeout(
        copyLatestResponseMarkdown(page),
        90000,
        "copyResult timed out",
      );
      const got = (markdown || "").trim().length;
      if (got < MIN_NOTE_CHARS) {
        throw Object.assign(
          new Error(
            `Copied response is too short (${got} chars) — the site's copy likely failed.`,
          ),
          { retryable: true },
        );
      }
      await closeNoteBrowser(context, acct.userDataDir);
      context = null;
      break;
    } catch (e) {
      await closeNoteBrowser(context, acct.userDataDir);
      context = null;
      // A browser that died mid-flow (crash, closed window, lost CDP transport)
      // is worth a clean retry rather than failing the whole lecture.
      if (
        !e.retryable &&
        /target closed|browser has been closed|has been closed|crash|protocol error|connection closed|websocket/i.test(
          e.message || "",
        )
      ) {
        e.retryable = true;
      }
      if (e.retryable && attempt < MAX_ATTEMPTS) {
        const delayMs = backoffDelay(attempt, retry);
        console.log(
          `[${acct.account}] Attempt ${attempt} hit transient error: ${e.message}. ` +
            `Retrying in ${Math.round(delayMs / 1000)}s...`,
        );
        await Bun.sleep(delayMs);
        continue;
      }
      throw e;
    }
  }

  mkdirSync(notesDir, { recursive: true });
  const noteName = basename(noteBaseName, extname(noteBaseName)) + ".md";
  const notePath = join(notesDir, noteName);
  await Bun.write(notePath, markdown);
  const saved = await Bun.file(notePath).text();
  if (saved.trim().length < MIN_NOTE_CHARS) {
    throw new Error(`Note ${notePath} is empty/too short — keeping input files for retry.`);
  }
  console.log(`[${acct.account}] Note saved: ${notePath} (${saved.length} chars).`);
  return { notePath, markdown, model: usedModel };
}

export { assertBrowserProfile };

/**
 * Push a saved note Markdown file to Notion if credentials are configured.
 * Reads ./notion.json (or NOTION_TOKEN / NOTION_DATABASE_ID / NOTION_PAGE_ID).
 * Never throws: a Notion failure leaves the local note intact.
 */
export async function pushNoteIfConfigured({ notePath, title, enabled = true }) {
  if (!enabled) {
    console.log(`[notion] skipped (--no-notion).`);
    return null;
  }
  let cfg;
  try {
    cfg = loadNotionConfig();
  } catch (e) {
    console.log(`[notion] config error: ${e.message} — skipping upload.`);
    return null;
  }
  if (!cfg.enabled) {
    console.log(`[notion] disabled in notion.json — skipping upload.`);
    return null;
  }
  if (!cfg.token || (!cfg.databaseId && !cfg.pageId)) {
    console.log(`[notion] not configured (create ./notion.json) — skipping upload.`);
    return null;
  }
  try {
    const markdown = await Bun.file(notePath).text();
    const url = await pushNoteToNotion({
      token: cfg.token,
      databaseId: cfg.databaseId,
      pageId: cfg.pageId,
      title,
      markdown,
    });
    console.log(`[notion] uploaded "${title}" -> ${url}`);
    return url;
  } catch (e) {
    console.log(`[notion] upload failed: ${e.message} — keeping local note.`);
    return null;
  }
}
