// Shared note pipeline used by main.js (single file) and batch.js (URL batch).
// Keeps the browser flow, upload/link helpers, and note saving in one place.
import { existsSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import {
  assertBrowserProfile,
  rcloneArgs,
  getRemoteSize,
  killStaleBrowser,
} from "./account.js";
import {
  NEW_CHAT_URL,
  gotoNewChat,
  setSystemInstructions,
  runPrompt,
  attachDriveLink,
  waitForAttachmentReady,
  waitForDone,
  copyLatestResponseMarkdown,
} from "./aistudio.js";
import { loadNotionConfig, pushNoteToNotion } from "./notion.js";

const SYS_FILE = "./system_instructions.md";

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
 * Reuses an existing byte-identical remote copy (dedup) instead of re-uploading.
 */
export function uploadAndLink(acct, localFile, remotePath = "uploads/") {
  const fileName = basename(localFile);
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
  const link = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "link", dest)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (link.exitCode !== 0) {
    throw new Error(`rclone link failed: ${link.stderr.toString().trim()}`);
  }
  const publicUrl = link.stdout.toString().trim();
  console.log(`[${acct.account}] Public link: ${publicUrl}`);
  return { dest, publicUrl };
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

// Force the note's leading H1 to the assigned lecture name (if any) so the note
// body, the note filename, and the Notion page title all agree.
function applyNoteTitle(markdown, title) {
  const nl = markdown.indexOf("\n");
  const first = (nl === -1 ? markdown : markdown.slice(0, nl)).trim();
  if (/^#{1,6}\s+\S/.test(first)) {
    return `# ${title}` + (nl === -1 ? "\n" : markdown.slice(nl));
  }
  return `# ${title}\n\n${markdown}`;
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
 * Run the AI Studio chat flow against an already-public file URL and save
 * the generated notes to <notesDir>/<noteBaseName without ext>.md.
 * Retries transient Google-side flakes with a fresh browser (up to 3 tries).
 */
export async function generateNoteFromUrl({
  acct,
  publicUrl,
  noteBaseName,
  title = null,
  sysText,
  windowMode = "show",
  genTimeoutMs = 30 * 60 * 1000,
  notesDir = "./notes",
}) {
  if (!WINDOW_MODES.has(windowMode)) {
    throw new Error(`Unknown window mode "${windowMode}" (use: ${[...WINDOW_MODES].join(", ")})`);
  }
  const headless = windowMode === "headless";
  const launchArgs =
    windowMode === "tile"
      ? ["--window-size=1100,720", "--window-position=0,0"]
      : undefined;

  const MAX_ATTEMPTS = 3;
  let markdown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const stale = killStaleBrowser(acct.userDataDir);
    if (stale.length) {
      console.log(`[${acct.account}] Killed stale browser PID(s): ${stale.join(", ")}.`);
      await Bun.sleep(2000);
    }
    let context = null;
    try {
      console.log(
        `[${acct.account}] Browser attempt ${attempt}/${MAX_ATTEMPTS} (${windowMode}) ...`,
      );
      try {
        context = await launchPersistentContext({
          userDataDir: acct.userDataDir,
          headless,
          ...(launchArgs ? { args: launchArgs } : {}),
        });
      } catch (e) {
        if (/already in use/i.test(e.message || "")) {
          throw new Error(
            `Browser profile ${acct.userDataDir} is already in use by another Chromium. ` +
              `Close it and re-run.`,
          );
        }
        throw e;
      }
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = context.pages()[0] ?? (await context.newPage());
      if (windowMode === "minimize") await minimizeWindow(page);
      await gotoNewChat(page);
      console.log(`[${acct.account}] New chat: ${NEW_CHAT_URL}`);

      await setSystemInstructions(page, sysText);
      console.log(`[${acct.account}] System instructions set from ${SYS_FILE}.`);

      const pasteMethod = await attachDriveLink(page, publicUrl);
      console.log(
        `[${acct.account}] Drive link pasted (via ${pasteMethod}). Waiting for file to load...`,
      );
      const chip = await waitForAttachmentReady(page);
      console.log(`[${acct.account}] File loaded: ${chip.text}`);

      await runPrompt(page);
      console.log(
        `[${acct.account}] Prompt sent (file attached). Waiting for generation (timeout ${Math.round(genTimeoutMs / 60000)} min)...`,
      );
      await waitForDone(page, { timeoutMs: genTimeoutMs });
      console.log(`[${acct.account}] Generation complete. Copying markdown...`);
      markdown = await copyLatestResponseMarkdown(page);
      try {
        await context.close();
      } catch {}
      context = null;
      break;
    } catch (e) {
      try {
        if (context) await context.close();
      } catch {}
      if (e.retryable && attempt < MAX_ATTEMPTS) {
        console.log(
          `[${acct.account}] Attempt ${attempt} hit transient error: ${e.message}. Restarting flow...`,
        );
        await Bun.sleep(5000);
        continue;
      }
      throw e;
    }
  }

  mkdirSync(notesDir, { recursive: true });
  if (title) markdown = applyNoteTitle(markdown, title);
  const noteName = basename(noteBaseName, extname(noteBaseName)) + ".md";
  const notePath = join(notesDir, noteName);
  await Bun.write(notePath, markdown);
  const saved = await Bun.file(notePath).text();
  if (!saved.trim()) {
    throw new Error(`Note ${notePath} is empty — keeping input files for retry.`);
  }
  console.log(`[${acct.account}] Note saved: ${notePath} (${saved.length} chars).`);
  return { notePath, markdown };
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
