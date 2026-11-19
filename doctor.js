#!/usr/bin/env bun
// Doctor: audit, repair, clean up, and resync the note archive.
//
//   bun doctor.js audit [--json] [--notes-dir DIR]
//   bun doctor.js scrub [--yes] [--names a,b]
//   bun doctor.js salvage [--yes] [--names a,b] [--notion]
//   bun doctor.js repair [--yes] [--dry-run] [--only severe|tiny|all] [--names a,b] [--wait MIN]
//   bun doctor.js cleanup [--yes] [--dry-run] [--drive] [--drive-noted] [--drive-noted]
//   bun doctor.js notion-dedupe [--yes] [--dry-run]
//   bun doctor.js notion-sync [--yes] [--dry-run] [--replace] [--names a,b]
//   bun doctor.js accounts
//   bun doctor.js models
//
// Destructive commands are dry-run unless `--yes` is passed. `repair` moves the
// old note to notes/.repair-backup/, regenerates it, validates the result, and
// only then archives the old Notion page and deletes the backup.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { loadConfig } from "./lib/config.js";
import { inspectNote, scrubNoteArtifacts, hasUiChrome, salvageNote, MIN_NOTE_CHARS } from "./lib/validate.js";
import { readHistory, stateDir } from "./lib/state.js";
import {
  archivePage,
  fetchExistingNoteTitles,
  findPagesByTitle,
  loadNotionConfig,
  pushNoteToNotion,
} from "./lib/notion.js";
import { resolveAccount, rcloneArgs } from "./lib/account.js";
import { lockOwner } from "./lib/lock.js";
import { listArchivedMedia, removeRemote } from "./lib/pipeline.js";

const ROOT = import.meta.dir;
const cfg = loadConfig();
const args = process.argv.slice(2);
const cmd = args[0] || "audit";
const has = (f) => args.includes(f);
const valueOf = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const notesDirArg = valueOf("--notes-dir", "./notes");
const notesDir = join(ROOT, notesDirArg);
const minChars = cfg.minNoteChars ?? MIN_NOTE_CHARS;
const yes = has("--yes");
const dryRun = has("--dry-run") || !yes;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function noteFiles(dir = notesDir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}

function auditNotes({ dir = notesDir, min = minChars } = {}) {
  const rows = [];
  for (const file of noteFiles(dir)) {
    const text = readFileSync(file, "utf8");
    const name = basename(file, ".md");
    // Clipboard UI chrome (`editmore_vert`, `thumb_upthumb_down 9m38.2s`) is
    // cosmetic: strip it before deciding whether the note needs regenerating.
    const chrome = hasUiChrome(text);
    const body = chrome ? scrubNoteArtifacts(text) : text;
    const check = inspectNote(body, { minChars: min });
    const errors = check.issues.filter((i) => i.severity === "error");
    rows.push({
      name,
      file,
      chars: body.length,
      rawChars: text.length,
      ok: check.ok,
      tiny: body.length < min,
      severe: errors.length > 0,
      chrome,
      issues: check.issues,
      errorCodes: errors.map((i) => i.code),
    });
  }
  return rows;
}

function printAudit(rows) {
  const bad = rows.filter((r) => !r.ok);
  const cosmetic = rows.filter((r) => r.chrome && r.ok);
  console.log(
    bold(
      `notes: ${rows.length} — valid: ${rows.length - bad.length}, invalid: ${bad.length}`,
    ),
  );
  if (!bad.length) {
    console.log(green("all notes pass validation."));
  } else {
    for (const r of bad.sort((a, b) => a.chars - b.chars)) {
      const codes = r.errorCodes.join(", ") || "warning";
      console.log(`  ${String(r.chars).padStart(7)}  ${r.name.padEnd(34)} ${red(codes)}`);
    }
  }
  if (cosmetic.length) {
    console.log(
      yellow(
        `\n${cosmetic.length} valid note(s) carry clipboard UI chrome — clean in place with \`bun doctor.js scrub --yes\`:`,
      ),
    );
    for (const r of cosmetic.sort((a, b) => a.chars - b.chars)) {
      console.log(dim(`  ${String(r.chars).padStart(7)}  ${r.name}`));
    }
  }

  // Download leftovers that can be mistaken for complete media.
  const downloadRoot = join(ROOT, "tmp", cfg.account || "ibny", "downloads");
  const leftovers = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(part|ytdl|inprogress|temp|tmp)$/i.test(e.name) || statSync(p).size === 0) {
        leftovers.push({ path: p, size: statSync(p).size });
      }
    }
  };
  walk(downloadRoot);
  if (leftovers.length) {
    console.log(`\n${bold("download leftovers:")}`);
    for (const l of leftovers) console.log(`  ${String(l.size).padStart(12)}  ${l.path}`);
  } else {
    console.log(`\n${green("no partial/zero-byte downloads.")}`);
  }

  const total = rows.reduce((a, r) => a + r.chars, 0);
  console.log(dim(`\ntotal note chars: ${total}`));
}

async function notionPagesByName(names) {
  const ncfg = loadNotionConfig();
  if (!ncfg.enabled || !ncfg.token || !ncfg.databaseId) {
    console.log(dim("notion: not configured — page replacement disabled."));
    return new Map();
  }
  const map = new Map();
  for (const name of names) {
    const pages = await findPagesByTitle({
      token: ncfg.token,
      databaseId: ncfg.databaseId,
      title: name,
    });
    map.set(name, pages);
  }
  return map;
}

async function archiveOldPages(name, oldPages, newPages) {
  const ncfg = loadNotionConfig();
  if (!ncfg.token) return 0;
  const keep = new Set((newPages || []).map((p) => p.id));
  let n = 0;
  for (const page of oldPages || []) {
    if (keep.has(page.id)) continue;
    if (dryRun) {
      console.log(dim(`  would archive old Notion page ${page.id} for "${name}"`));
      continue;
    }
    await archivePage({ token: ncfg.token, pageId: page.id });
    console.log(`  archived old Notion page ${page.id} for "${name}"`);
    n++;
  }
  return n;
}

async function cmdScrub() {
  const wanted = valueOf("--names", null)?.split(",").map((s) => s.trim()).filter(Boolean);
  let rows = auditNotes().filter((r) => r.chrome);
  if (wanted) rows = rows.filter((r) => wanted.includes(r.name));
  console.log(bold(`clipboard-chrome scrub: ${rows.length} note(s)`));
  let done = 0;
  for (const r of rows) {
    const raw = readFileSync(r.file, "utf8");
    const clean = scrubNoteArtifacts(raw);
    const check = inspectNote(clean, { minChars });
    const removed = raw.length - clean.length;
    const state = check.ok ? green("ok") : yellow(check.issues.filter((i) => i.severity === "error").map((i) => i.code).join(", "));
    console.log(`  ${r.name.padEnd(34)} -${String(removed).padStart(5)} chars  ${state}`);
    if (dryRun || !check.ok) continue;
    await Bun.write(r.file, clean);
    done++;
  }
  if (dryRun) {
    console.log(dim("\ndry run — pass --yes to rewrite the files in place."));
  } else {
    console.log(bold(`\nscrubbed ${done}/${rows.length}.`));
  }
}

async function cmdSalvage() {
  const wanted = valueOf("--names", null)?.split(",").map((s) => s.trim()).filter(Boolean);
  const pushNotion = has("--notion");
  let rows = auditNotes().filter((r) => !r.ok);
  if (wanted) rows = rows.filter((r) => wanted.includes(r.name));
  console.log(bold(`salvage: ${rows.length} invalid note(s)`));
  const repaired = [];
  for (const r of rows) {
    const raw = readFileSync(r.file, "utf8");
    const s = salvageNote(raw, { minChars });
    if (!s.ok) {
      const codes = s.issues.filter((i) => i.severity === "error").map((i) => i.code).join(", ");
      console.log(`  ${r.name.padEnd(34)} ${red("not salvageable")} (${codes})`);
      continue;
    }
    console.log(`  ${r.name.padEnd(34)} ${green("salvageable")} ${dim(`(${raw.length} -> ${s.text.length} chars)`)}`);
    for (const c of s.changes) console.log(dim(`      ${c}`));
    if (dryRun) continue;
    const backupDir = join(notesDir, ".repair-backup");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, r.name + ".md");
    if (!existsSync(backup)) await Bun.write(backup, raw);
    await Bun.write(r.file, s.text);
    repaired.push(r.name);
  }
  if (dryRun) {
    console.log(dim("\ndry run — pass --yes to rewrite the notes in place (add --notion to replace the pages)."));
    return;
  }
  console.log(bold(`\nsalvaged ${repaired.length}/${rows.length}.`));
  if (!pushNotion || !repaired.length) return;

  const ncfg = loadNotionConfig();
  if (!ncfg.enabled || !ncfg.token || !ncfg.databaseId) {
    console.log(yellow("\nnotion is not configured — pages not replaced."));
    return;
  }
  for (const name of repaired) {
    const markdown = readFileSync(join(notesDir, name + ".md"), "utf8");
    const old = await findPagesByTitle({ token: ncfg.token, databaseId: ncfg.databaseId, title: name });
    await pushNoteToNotion({
      token: ncfg.token,
      databaseId: ncfg.databaseId,
      pageId: ncfg.pageId,
      title: name,
      markdown,
    });
    const now = await findPagesByTitle({ token: ncfg.token, databaseId: ncfg.databaseId, title: name });
    const fresh = now.filter((p) => !old.some((o) => o.id === p.id));
    if (fresh.length) await archiveOldPages(name, old, fresh);
    else console.log(yellow(`  ${name}: new Notion page not found — old page kept.`));
    console.log(`  replaced Notion page for ${name}`);
  }
}

async function cmdRepair() {
  const only = valueOf("--only", "all");
  const wanted = valueOf("--names", null)?.split(",").map((s) => s.trim()).filter(Boolean);
  let rows = auditNotes().filter((r) => !r.ok);
  if (wanted) rows = rows.filter((r) => wanted.includes(r.name));
  if (only === "tiny") rows = rows.filter((r) => r.tiny);
  if (only === "severe") rows = rows.filter((r) => r.severe);

  const ncfg = loadNotionConfig();
  const acct = resolveAccount(cfg.account || "ibny");
  const archived = cfg.archive?.enabled ?? true
    ? listArchivedMedia(acct, cfg.archive?.folder || "Classes")
    : new Map();

  const entries = [];
  const skipped = [];
  for (const r of rows) {
    const archiveDest = archived.get(r.name) || null;
    const local = findLocalMedia(r.name);
    if (!archiveDest && !local) {
      skipped.push({ name: r.name, reason: "no archived or local media" });
      continue;
    }
    entries.push({ ...r, archiveDest, local });
  }

  console.log(bold(`repair plan: ${entries.length} note(s)`));
  for (const e of entries) {
    console.log(
      `  ${e.name.padEnd(34)} ${String(e.chars).padStart(7)}  ${e.errorCodes.join(", ")}  [${e.archiveDest ? "archive" : "local"}]`,
    );
  }
  if (skipped.length) {
    console.log(yellow(`\nskipped ${skipped.length}:`));
    for (const s of skipped) console.log(`  ${s.name} — ${s.reason}`);
  }
  if (!entries.length) return;
  if (dryRun) {
    console.log(dim("\ndry run — pass --yes to restore media, regenerate, and replace the Notion pages."));
    return;
  }

  // A live batch already owns the account's browser profile: starting a second
  // one would only reap its Chromium (or stall on the profile lock), and every
  // minute of restore work would be wasted. Fail fast, or wait it out on request.
  const lockPath = join(stateDir(cfg), `${acct.account}.lock`);
  const holder = lockOwner(lockPath);
  if (holder) {
    const waitMin = Number(valueOf("--wait", "0")) || 0;
    if (!waitMin) {
      console.log(
        yellow(
          `\nanother run is active for "${acct.account}" (PID ${holder}) — repairing now would fight it for the browser.`,
        ),
      );
      console.log(
        dim("wait for it to finish, or add --wait 120 to start automatically once the lock is released."),
      );
      process.exitCode = 1;
      return;
    }
    console.log(yellow(`\nwaiting up to ${waitMin} min for PID ${holder} ("${acct.account}") to release the browser ...`));
    const deadline = Date.now() + waitMin * 60_000;
    while (lockOwner(lockPath)) {
      if (Date.now() > deadline) {
        console.log(red(`gave up after ${waitMin} min — PID ${lockOwner(lockPath) || "?"} still holds ${lockPath}.`));
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
    console.log(green("lock is free — starting the repair."));
  }

  // Back up every note before touching anything.
  const backupDir = join(notesDir, ".repair-backup");
  mkdirSync(backupDir, { recursive: true });
  const backups = new Map();
  for (const e of entries) {
    const dest = join(backupDir, e.name + ".md");
    renameSync(e.file, dest);
    backups.set(e.name, dest);
  }

  // Capture old Notion pages before the batch pushes replacements.
  const oldPages = await notionPagesByName(entries.map((e) => e.name));

  // History carries no source URLs, so repair regenerates from the archived
  // Drive copy (or a surviving local download). Restore each archive locally and
  // hand batch.js a name<TAB>path manifest; from there the normal chunk, slide,
  // fallback, validate, and Notion path runs unchanged.
  const restoreDir = join(ROOT, "tmp", cfg.account || "ibny", "repair");
  mkdirSync(restoreDir, { recursive: true });
  const mediaLines = [];
  const restorable = [];
  for (const e of entries) {
    // Prefer the archived copy: it is the upload that produced the note, while a
    // local leftover may be a half-converted download.
    let file = null;
    if (e.archiveDest) {
      const ext = extname(e.archiveDest) || ".mp3";
      file = join(restoreDir, e.name.replace(/[^\w.\- ]+/g, "_") + ext);
      if (!(existsSync(file) && statSync(file).size > 0)) {
        console.log(`  restoring ${e.name} from Drive ...`);
        const proc = Bun.spawnSync(
          ["rclone", ...rcloneArgs(acct.rcloneConfig, "copyto", e.archiveDest, file)],
          { stdout: "pipe", stderr: "pipe" },
        );
        if (proc.exitCode !== 0) {
          console.log(red(`  ${e.name}: restore failed: ${proc.stderr.toString().trim().slice(0, 300)}`));
          file = null;
        }
      }
    }
    if (!file) file = e.local;
    if (!file) {
      const backup = backups.get(e.name);
      if (backup && existsSync(backup)) renameSync(backup, join(notesDir, e.name + ".md"));
      continue;
    }
    restorable.push(e);
    mediaLines.push(`${e.name}\t${file}\t${e.archiveDest || ""}`);
  }

  if (!restorable.length) {
    console.log(red("no media could be restored — nothing regenerated."));
    return;
  }

  const mediaFile = join(ROOT, "tmp", `repair-${Date.now()}.tsv`);
  mkdirSync(dirname(mediaFile), { recursive: true });
  await Bun.write(mediaFile, mediaLines.join("\n") + "\n");

  console.log(bold(`\nregenerating ${restorable.length} note(s) ...`));
  const proc = Bun.spawn(
    ["bun", "batch.js", "--media-file", mediaFile, "--force", "--no-resume", "--keep-local"],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;

  // Validate each result; only replace Notion when the new note is healthy.
  let repaired = 0;
  for (const e of restorable) {
    const file = join(notesDir, e.name + ".md");
    const backup = backups.get(e.name);
    if (!existsSync(file)) {
      if (backup && existsSync(backup)) renameSync(backup, file);
      console.log(red(`  ${e.name}: no new note — restored the old file.`));
      continue;
    }
    const check = inspectNote(readFileSync(file, "utf8"), { minChars });
    if (!check.ok) {
      if (backup && existsSync(backup)) {
        unlinkSync(file);
        renameSync(backup, file);
      }
      console.log(red(`  ${e.name}: new note still invalid (${check.issues.map((i) => i.code).join(", ")}) — restored old file.`));
      continue;
    }
    if (backup && existsSync(backup)) unlinkSync(backup);
    if (ncfg.enabled && ncfg.token && ncfg.databaseId) {
      const nowPages = await findPagesByTitle({
        token: ncfg.token,
        databaseId: ncfg.databaseId,
        title: e.name,
      });
      const old = oldPages.get(e.name) || [];
      const newOnes = nowPages.filter((p) => !old.some((o) => o.id === p.id));
      if (newOnes.length) await archiveOldPages(e.name, old, newOnes);
      else console.log(yellow(`  ${e.name}: note repaired locally, but Notion has no new page (old page kept).`));
    }
    repaired++;
    console.log(green(`  ${e.name}: repaired (${readFileSync(file, "utf8").length} chars).`));
  }
  console.log(bold(`\nrepaired ${repaired}/${restorable.length}; batch exit ${code}.`));
  console.log(dim(`media manifest: ${mediaFile}`));
}

function findLocalMedia(name) {
  const root = join(ROOT, "tmp", cfg.account || "ibny", "downloads");
  const exts = [".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav", ".mp4", ".webm", ".mkv", ".mov", ".ts"];
  const walk = (dir) => {
    if (!existsSync(dir)) return null;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (extname(e.name).toLowerCase() && e.name === name + extname(e.name).toLowerCase()) {
        if (exts.includes(extname(e.name).toLowerCase()) && statSync(p).size > 0) return p;
      }
    }
    return null;
  };
  return walk(root);
}

/**
 * Drive objects that are safe to delete unconditionally: interrupted download
 * fragments (`.part`, `.ytdl`, `.inprogress`) and zero-byte placeholders. A
 * complete recording is never selected — it is the only way to regenerate a
 * broken note — unless `--drive-noted` is passed explicitly.
 */
function drivePartials(acct, folder) {
  const remote = `${acct.rcloneRemote}${String(folder).replace(/\/$/, "")}`;
  const proc = Bun.spawnSync(
    ["rclone", ...rcloneArgs(acct.rcloneConfig, "lsjson", "--files-only", `${remote}/`)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.log(yellow(`could not list ${remote}/: ${proc.stderr.toString().trim().slice(0, 200)}`));
    return [];
  }
  let items = [];
  try {
    items = JSON.parse(proc.stdout.toString());
  } catch {
    return [];
  }
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const rel = it.Path || it.Name;
    if (!rel) continue;
    const partial = /\.(part|ytdl|inprogress|temp|tmp)$/i.test(rel);
    const zero = (it.Size ?? 0) === 0;
    if (!partial && !zero) continue;
    out.push({
      kind: partial ? "drive-partial" : "drive-zero",
      path: `${remote}/${rel}`,
      name: rel,
      size: it.Size ?? 0,
    });
  }
  return out;
}

async function cmdCleanup() {
  const downloadRoot = join(ROOT, "tmp", cfg.account || "ibny", "downloads");
  const rows = auditNotes();
  const validNames = new Set(rows.filter((r) => r.ok).map((r) => r.name));
  const actions = [];

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const size = statSync(p).size;
      const ext = extname(e.name).toLowerCase();
      if (/\.(part|ytdl|inprogress|temp|tmp)$/i.test(e.name) || size === 0) {
        actions.push({ kind: "partial/zero", path: p, size });
        continue;
      }
      const stem = basename(e.name, ext);
      if (validNames.has(stem) && [".mp3", ".mp4", ".webm", ".m4a", ".opus", ".ogg", ".flac", ".wav"].includes(ext)) {
        actions.push({ kind: "noted-media", path: p, size, name: stem });
      }
    }
  };
  walk(downloadRoot);

  let driveActions = [];
  if (has("--drive") || has("--drive-noted")) {
    const acct = resolveAccount(cfg.account || "ibny");
    const folder = cfg.archive?.folder || "Classes";
    if (has("--drive")) driveActions.push(...drivePartials(acct, folder));
    if (has("--drive-noted")) {
      const archived = listArchivedMedia(acct, folder);
      for (const [stem, dest] of archived) {
        if (validNames.has(stem)) driveActions.push({ kind: "drive-media", path: dest, name: stem });
      }
    }
  }

  const total = actions.reduce((a, x) => a + (x.size || 0), 0);
  console.log(bold(`cleanup plan: ${actions.length} local file(s), ${(total / 1e6).toFixed(1)} MB`));
  for (const a of actions) {
    console.log(`  ${a.kind.padEnd(14)} ${String(a.size).padStart(12)}  ${a.path}`);
  }
  if (driveActions.length) {
    console.log(bold(`\nDrive archive: ${driveActions.length} object(s) to delete`));
    for (const a of driveActions.slice(0, 30)) {
      console.log(`  ${a.kind.padEnd(14)} ${String(a.size ?? "").padStart(12)}  ${a.name}`);
    }
    if (driveActions.length > 30) console.log(dim(`  ... and ${driveActions.length - 30} more`));
  }
  if (!actions.length && !driveActions.length) {
    console.log(green("nothing to clean."));
    return;
  }
  if (dryRun) {
    console.log(dim("\ndry run — pass --yes to delete. Add --drive to prune partial/zero-byte Drive objects."));
    return;
  }

  const acct = resolveAccount(cfg.account || "ibny");
  for (const a of actions) {
    try {
      unlinkSync(a.path);
      // Remove the completion marker too, if any.
      try { unlinkSync(a.path + ".complete"); } catch {}
      console.log(`  deleted ${a.path}`);
    } catch (e) {
      console.log(red(`  failed to delete ${a.path}: ${e.message}`));
    }
  }
  for (const a of driveActions) {
    removeRemote(acct, a.path);
  }
}

async function cmdNotionDedupe() {
  const ncfg = loadNotionConfig();
  if (!ncfg.enabled || !ncfg.token || !ncfg.databaseId) {
    console.log(yellow("notion is not configured."));
    return;
  }
  const rows = auditNotes();
  const tinyOrBad = rows.filter((r) => !r.ok).map((r) => r.name);
  const history = readHistory(stateDir(cfg));
  const okByName = new Map();
  for (const rec of history) {
    if (rec.status !== "ok" || !rec.name) continue;
    if (!okByName.has(rec.name)) okByName.set(rec.name, []);
    okByName.get(rec.name).push(rec);
  }
  let planned = 0;
  for (const [name, recs] of okByName) {
    if (recs.length < 2) continue;
    const pages = await findPagesByTitle({ token: ncfg.token, databaseId: ncfg.databaseId, title: name });
    if (pages.length < 2) continue;
    const newest = [...recs].sort((a, b) => String(a.at).localeCompare(String(b.at))).pop();
    const keep = pages.find((p) => p.url === newest.notionUrl) || pages.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime))).pop();
    console.log(`${name}: ${pages.length} pages, keeping ${keep.url}`);
    for (const p of pages) {
      if (p.id === keep.id) continue;
      planned++;
      if (dryRun) console.log(dim(`  would archive ${p.url}`));
      else {
        await archivePage({ token: ncfg.token, pageId: p.id });
        console.log(`  archived ${p.url}`);
      }
    }
  }
  if (!planned) console.log(green("no duplicate Notion pages found."));
  else if (dryRun) console.log(dim(`\ndry run — pass --yes to archive ${planned} duplicate page(s).`));
  if (tinyOrBad.length) console.log(yellow(`\n${tinyOrBad.length} invalid note(s) still need repair first.`));
}

async function cmdNotionSync() {
  const ncfg = loadNotionConfig();
  if (!ncfg.enabled || !ncfg.token || !ncfg.databaseId) {
    console.log(yellow("notion is not configured."));
    return;
  }
  const replace = has("--replace");
  const wanted = valueOf("--names", null)?.split(",").map((s) => s.trim()).filter(Boolean);
  const titles = await fetchExistingNoteTitles({ token: ncfg.token, databaseId: ncfg.databaseId });
  let rows = auditNotes().filter((r) => r.ok && (replace || !titles.has(r.name)));
  if (wanted) rows = rows.filter((r) => wanted.includes(r.name));
  console.log(
    bold(
      replace
        ? `notion sync (replace): ${rows.length} valid note(s) will be re-pushed`
        : `notion sync: ${rows.length} valid note(s) missing from Notion`,
    ),
  );
  for (const r of rows) console.log(`  ${r.name}`);
  if (!rows.length) return;
  if (dryRun) {
    console.log(dim("\ndry run — pass --yes to push them."));
    return;
  }
  for (const r of rows) {
    const markdown = readFileSync(r.file, "utf8");
    // In replace mode the old page is archived only after the new one exists,
    // so a failed push never removes the only page.
    try {
      const old = replace
        ? await findPagesByTitle({ token: ncfg.token, databaseId: ncfg.databaseId, title: r.name })
        : [];
      const url = await pushNoteToNotion({
        token: ncfg.token,
        databaseId: ncfg.databaseId,
        pageId: ncfg.pageId,
        title: r.name,
        markdown,
      });
      if (replace && old.length) {
        const now = await findPagesByTitle({
          token: ncfg.token,
          databaseId: ncfg.databaseId,
          title: r.name,
        });
        const fresh = now.filter((p) => !old.some((o) => o.id === p.id));
        if (fresh.length) await archiveOldPages(r.name, old, fresh);
        else console.log(yellow(`  ${r.name}: new page not found — old page kept.`));
      }
      console.log(`  pushed ${r.name} -> ${url}`);
    } catch (e) {
      console.log(red(`  ${r.name}: push failed — ${e.message.slice(0, 300)}`));
    }
  }
}

function cmdAccounts() {
  const authDir = join(ROOT, "auth");
  console.log(bold("browser profiles:"));
  if (existsSync(authDir)) {
    for (const e of readdirSync(authDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const rclone = join(authDir, e.name, "rclone.conf");
      console.log(`  ${e.name.padEnd(20)} profile=yes rclone=${existsSync(rclone) ? "yes" : "no"}`);
    }
  }
  console.log(bold("\nconfig:"));
  console.log(`  primary:  ${cfg.account}`);
  const backups = [...new Set([cfg.backupAccount, ...(cfg.accounts?.backups || [])].filter(Boolean))];
  console.log(`  backups:  ${backups.join(", ") || "(none)"}`);
  for (const b of backups) {
    const ok = existsSync(join(authDir, b));
    console.log(
      ok
        ? `    ${b.padEnd(18)} profile=yes`
        : `    ${b.padEnd(18)} profile=MISSING — run: bun login.js ${b}`,
    );
  }
  console.log(`  strategy: ${cfg.accounts?.strategy || "on-failure"}`);
  console.log(`  model:    ${cfg.model}`);
}

function printUsage() {
  console.log(`Usage:
  bun doctor.js audit [--json] [--notes-dir DIR]
  bun doctor.js scrub [--yes] [--names a,b]
  bun doctor.js salvage [--yes] [--names a,b] [--notion]
  bun doctor.js repair [--yes] [--dry-run] [--only severe|tiny|all] [--names a,b]
  bun doctor.js cleanup [--yes] [--dry-run] [--drive]
  bun doctor.js notion-dedupe [--yes] [--dry-run]
  bun doctor.js notion-sync [--yes] [--dry-run]
  bun doctor.js accounts
  bun doctor.js models`);
}

switch (cmd) {
  case "audit": {
    const rows = auditNotes();
    if (has("--json")) console.log(JSON.stringify(rows, null, 2));
    else printAudit(rows);
    break;
  }
  case "repair":
    await cmdRepair();
    break;
  case "scrub":
    await cmdScrub();
    break;
  case "salvage":
  case "patch":
    await cmdSalvage();
    break;
  case "cleanup":
  case "clean":
    await cmdCleanup();
    break;
  case "notion-dedupe":
  case "dedupe":
    await cmdNotionDedupe();
    break;
  case "notion-sync":
  case "sync":
    await cmdNotionSync();
    break;
  case "accounts":
    cmdAccounts();
    break;
  case "models": {
    const proc = Bun.spawn(["bun", "config.js", "models"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
    break;
  }
  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;
  default:
    printUsage();
    process.exitCode = 1;
}
