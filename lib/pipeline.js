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
import { ensureMemoryHeadroom } from "./memory.js";
import {
  gotoNewChat,
  setSystemInstructions,
  runPrompt,
  attachDriveLink,
  waitForAttachmentsReady,
  waitForDone,
  copyLatestResponseMarkdown,
  assertNoChatError,
  withTimeout,
} from "./aistudio.js";
import {
  LATEST_FLASH,
  currentModelSlug,
  modelWarning,
  newChatUrl,
  resolveModel,
} from "./models.js";
import { backoffDelay } from "./retry.js";
import { loadNotionConfig, pushNoteToNotion, fetchExistingNoteTitles } from "./notion.js";
import { sanitizeMath } from "./sanitize.js";
import { assertValidNote, scrubNoteArtifacts, MIN_NOTE_CHARS } from "./validate.js";
import { ModelUnavailableError } from "./errors.js";

const SYS_FILE = "./system_instructions.md";

// Failures a fresh browser on the same account/model cannot fix: retrying them
// here only adds a launch + attach cycle per attempt, so they bubble straight to
// generateWithFallback (next model, then next account).
const POLICY_KINDS = new Set([
  "verification",
  "quota",
  "rate_limit",
  "model_missing",
  "context",
  "safety",
  "file_load",
  "max_tokens",
  "memory",
]);

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
      throw new Error(rcloneFailure("rclone copyto", upload));
    }
  }
  const publicUrl = remoteLink(acct, dest);
  console.log(`[${acct.account}] Public link: ${publicUrl}`);
  return { dest, publicUrl };
}

/**
 * A readable rclone failure. The shared-`client_id` NOTICE is emitted even on
 * success, so it is kept only when it is the sole output (otherwise it reads
 * like the cause of an unrelated failure).
 */
function rcloneFailure(op, proc) {
  const lines = proc.stderr
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.filter(
    (l) => !/NOTICE: .*shared Google Drive client_id/i.test(l),
  );
  const detail = (meaningful.length ? meaningful : lines).join(" | ");
  return `${op} failed (exit ${proc.exitCode}): ${detail || "no stderr output"}`;
}

/** `rclone link` for an existing remote file -> public URL. */
export function remoteLink(acct, dest) {
  const link = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "link", dest)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (link.exitCode !== 0) {
    throw new Error(rcloneFailure("rclone link", link));
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

export async function minimizeWindow(page) {
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
 * (audio first, then its slide PDF) and return the generated Markdown without
 * saving it. Used by single notes, chunked parts, and repair.
 *
 * Retries transient Google-side flakes with a fresh browser. Model-specific
 * failures are thrown as ModelUnavailableError so the caller can try another
 * model/account; the page's own "not recognized" warning is checked too.
 */
export async function generateMarkdown({
  acct,
  publicUrl,
  publicUrls,
  sysText,
  windowMode = "show",
  model = LATEST_FLASH,
  genTimeoutMs = 10 * 60 * 1000,
  retry = { attempts: 3, baseDelayMs: 5000, maxDelayMs: 60000 },
  extraInstruction = null,
  minChars = MIN_NOTE_CHARS,
  // Log prefix override (e.g. "L2 ") so interleaved concurrent lanes are
  // distinguishable in the output.
  label = null,
  // Optional: return a shared browser context for this account (one Chromium,
  // one tab per concurrent note). Omitted -> the pipeline launches its own.
  getSession = null,
}) {
  const urls = publicUrls && publicUrls.length ? publicUrls : [publicUrl];
  if (!urls[0]) throw new Error("generateMarkdown needs publicUrl or publicUrls");
  if (!WINDOW_MODES.has(windowMode)) {
    throw new Error(`Unknown window mode "${windowMode}" (use: ${[...WINDOW_MODES].join(", ")})`);
  }
  const headless = windowMode === "headless";
  const launchArgs =
    windowMode === "tile"
      ? ["--window-size=1100,720", "--window-position=0,0"]
      : undefined;
  const instructions = extraInstruction ? `${sysText}\n\n${extraInstruction}` : sysText;
  const who = label || acct.account;

  const MAX_ATTEMPTS = retry?.attempts > 0 ? retry.attempts : 3;
  // Outer watchdog for one attempt. Inner steps have their own timeouts, but
  // those are checked in JS between `page.evaluate()` calls — if the CDP
  // transport wedges, an `evaluate` never returns and the inner caps can never
  // fire. This ceiling is a plain timer, so it fires regardless.
  const perAttemptTimeoutMs = genTimeoutMs + 4 * 60 * 1000;
  let markdown = null;
  let usedModel = model;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let context = null;
    let page = null;
    let shared = false;
    try {
      console.log(
        `[${who}] Browser attempt ${attempt}/${MAX_ATTEMPTS} (${windowMode}) ...`,
      );
      if (getSession) {
        // One browser per account, one tab per note: Playwright cannot open the
        // same profile twice, and this mirrors the manual multi-tab workflow.
        context = await getSession(acct);
        shared = true;
        if (!context) throw new Error("getSession returned no browser context");
      } else {
        context = await launchNoteBrowser({
          userDataDir: acct.userDataDir,
          headless,
          args: launchArgs,
        });
      }
      const ctx = context;
      page = shared
        ? await (async () => {
            // Another concurrent tab is about to open; make sure the machine
            // still has headroom before adding a renderer.
            await ensureMemoryHeadroom({ label: "another browser tab" });
            return withTimeout(ctx.newPage(), 30000, "newPage timed out");
          })()
        : (ctx.pages()[0] ?? (await ctx.newPage()));
      page.setDefaultTimeout(30000);
      if (!shared) {
        await withTimeout(
          ctx.grantPermissions(["clipboard-read", "clipboard-write"]),
          30000,
          "grantPermissions timed out",
        ).catch((e) => console.log(`[${who}] warning: ${e.message}`));
        if (windowMode === "minimize") await minimizeWindow(page);
      }
      const flow = (async () => {

        // Pick the model. "latest-flash" reads the live picker; a concrete slug
        // is navigated to directly, then verified against the picker/warning.
        let modelSlug = model;
        if (model === LATEST_FLASH) {
          await withTimeout(gotoNewChat(page), 60000, "gotoNewChat timed out");
          const { slug, source } = await resolveModel(page, model);
          modelSlug = slug;
          if ((await currentModelSlug(page)) !== slug) {
            await withTimeout(gotoNewChat(page, slug), 60000, "gotoNewChat(model) timed out");
          }
          console.log(`[${who}] Model: ${modelSlug} (${source})`);
        } else {
          await withTimeout(gotoNewChat(page, model), 60000, "gotoNewChat timed out");
          // The site silently substitutes its default model for an unknown
          // slug; catch that instead of generating with the wrong model.
          const warning = await modelWarning(page);
          if (warning) throw new ModelUnavailableError(warning);
          console.log(`[${who}] Model: ${modelSlug}`);
        }
        usedModel = modelSlug;
        console.log(`[${who}] New chat: ${newChatUrl(modelSlug)}`);

        await withTimeout(
          setSystemInstructions(page, instructions),
          90000,
          "setSystemInstructions timed out",
        );
        console.log(`[${who}] System instructions set from ${SYS_FILE}.`);

        const pasteMethods = [];
        for (const [idx, u] of urls.entries()) {
          const method = await withTimeout(
            attachDriveLink(page, u),
            90000,
            `attach file ${idx + 1} timed out`,
          );
          pasteMethods.push(method);
          console.log(
            `[${who}] Attached file ${idx + 1}/${urls.length} (via ${method}).`,
          );
        }
        console.log(`[${who}] Waiting for ${urls.length} file(s) to load...`);
        const chip = await waitForAttachmentsReady(page, urls.length);
        console.log(`[${who}] Files loaded: ${chip.text}`);

        await withTimeout(runPrompt(page), 90000, "runPrompt timed out");
        console.log(
          `[${who}] Prompt sent (file attached). Waiting for generation (timeout ${Math.round(genTimeoutMs / 60000)} min)...`,
        );
        await waitForDone(page, {
          timeoutMs: genTimeoutMs,
          onProgress: ({ elapsedMs, len, stop }) =>
            console.log(
              `[${who}] ...generating ${Math.round(elapsedMs / 1000)}s ` +
                `(${len} chars, ${stop ? "running" : "idle"})`,
            ),
        });
        // A blocked response (recitation/copyright, safety, quota) can settle
        // into the "done" state with only a notice in the turn. Check once more
        // so the failure is classified (and retried on another model) instead of
        // being copied as a note.
        await assertNoChatError(page);
        console.log(`[${who}] Generation complete. Copying markdown...`);
        const text = await withTimeout(
          copyLatestResponseMarkdown(page),
          90000,
          "copyResult timed out",
        );
        const got = (text || "").trim().length;
        if (got < minChars) {
          throw Object.assign(
            new Error(
              `Copied response is too short (${got} chars) — the site's copy likely failed.`,
            ),
            { retryable: true },
          );
        }
        return text;
      })();
      // If the watchdog wins the race, the doomed flow keeps running against a
      // browser we are about to close — swallow its eventual rejection.
      flow.catch(() => {});
      markdown = await withTimeout(flow, perAttemptTimeoutMs, "Note attempt exceeded its hard time limit");
      if (shared) await page.close().catch(() => {});
      else await closeNoteBrowser(ctx, acct.userDataDir);
      context = null;
      break;
    } catch (e) {
      if (shared) await page?.close().catch(() => {});
      else await closeNoteBrowser(context, acct.userDataDir);
      context = null;
      // A browser that died or wedged mid-flow (crash, closed window, lost CDP
      // transport) or a navigation/selector timeout is transient — retry the
      // whole lecture rather than dropping it.
      if (
        !e.retryable &&
        /target closed|browser has been closed|has been closed|crash|protocol error|connection closed|websocket|timeout|timed out|net::|ERR_/i.test(
          e.message || "",
        )
      ) {
        e.retryable = true;
      }
      // Policy failures are not browser flakes (see POLICY_KINDS).
      if (e.retryable && attempt < MAX_ATTEMPTS && !POLICY_KINDS.has(e.kind)) {
        const delayMs = backoffDelay(attempt, retry);
        console.log(
          `[${who}] Attempt ${attempt} hit transient error: ${e.message}. ` +
            `Retrying in ${Math.round(delayMs / 1000)}s...`,
        );
        await Bun.sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  return { markdown, model: usedModel };
}

/**
 * Generate one note from already-public file URLs and save it to
 * <notesDir>/<noteBaseName without ext>.md. The note is validated before it is
 * written, so a truncated/error response can never become a "successful" note.
 */
export async function generateNoteFromUrl({
  acct,
  publicUrl,
  publicUrls,
  noteBaseName,
  sysText,
  windowMode = "show",
  model = LATEST_FLASH,
  genTimeoutMs = 10 * 60 * 1000,
  retry = { attempts: 3, baseDelayMs: 5000, maxDelayMs: 60000 },
  notesDir = "./notes",
  minChars = MIN_NOTE_CHARS,
  extraInstruction = null,
}) {
  const { markdown, model: usedModel } = await generateMarkdown({
    acct,
    publicUrl,
    publicUrls,
    sysText,
    windowMode,
    model,
    genTimeoutMs,
    retry,
    extraInstruction,
    minChars,
  });

  mkdirSync(notesDir, { recursive: true });
  // Drop native-script prose the model may have placed inside math (KaTeX
  // cannot render it) and obvious UI/CLI wrappers before validating.
  const cleaned = sanitizeMath(scrubNoteArtifacts(markdown));
  assertValidNote(cleaned, { minChars });
  const noteName = basename(noteBaseName, extname(noteBaseName)) + ".md";
  const notePath = join(notesDir, noteName);
  await Bun.write(notePath, cleaned);
  console.log(`[${acct.account}] Note saved: ${notePath} (${cleaned.length} chars).`);
  return { notePath, markdown: cleaned, model: usedModel };
}

/**
 * Build the per-part system-instruction suffix. Keeping the same output
 * contract, but telling the model this is one segment of a longer lecture,
 * avoids it inventing an intro/outro and makes merged notes read continuously.
 */
export function partInstruction(index, count, totalLabel = "") {
  if (count <= 1) return null;
  const where = `${index} of ${count}`;
  return [
    `<lecture_part>`,
    `This audio is part ${where} of a longer lecture${totalLabel ? ` (${totalLabel})` : ""}.`,
    `Transcribe and compile ONLY this part; do not summarise the whole lecture and do not add an intro or closing.`,
    `Start with a short contextual heading only if the part begins a new topic.`,
    `Do not repeat material from earlier parts; if a sentence continues from the previous part, continue it naturally.`,
    `Follow every output and math rule above exactly.`,
    `</lecture_part>`,
  ].join("\n");
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

/**
 * Titles of notes already in Notion, for resume. Empty when Notion is disabled
 * or not configured (or the listing fails) — callers then fall back to local
 * note files. Never throws.
 */
export async function existingNotionTitles({ enabled = true } = {}) {
  if (!enabled) return new Set();
  let cfg;
  try {
    cfg = loadNotionConfig();
  } catch (e) {
    console.log(`[notion] config error: ${e.message} — resume will use local files only.`);
    return new Set();
  }
  if (!cfg.enabled || !cfg.token || !cfg.databaseId) return new Set();
  return fetchExistingNoteTitles({ token: cfg.token, databaseId: cfg.databaseId });
}
