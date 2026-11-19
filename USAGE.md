# Zaknotes v2

Clipboard URLs → yt-dlp download → rclone Drive link → Google AI Studio note,
saved to `notes/` and pushed to Notion. One command, no intermediate Drive
re-download.

Long lectures are split **by duration** (not file size), generated in parts,
validated, merged, and pushed as one Notion page. Google accounts and models
fall back automatically when one is rate-limited, out of quota, unverified, or
missing a model.

Replaces the old `batch-notes` / `batch-dl` scripts.

---

## 1. Requirements

| Tool | Purpose |
| --- | --- |
| [Bun](https://bun.sh) | runtime (all scripts are `bun *.js`) |
| `yt-dlp` | media download (YouTube / Apars m3u8) |
| `rclone` | upload to the `ibny:` remote and mint a public link |
| CloakBrowser (`cloakbrowser`) | managed Chromium used for AI Studio |
| `ffmpeg` / `ffprobe` | duration probing, chunk splitting, `--clean-audio` |
| `pdfinfo`, `pdfseparate`, `pdfunite` | slide page counting/splitting (poppler-utils) |

One-time setup:

- A logged-in browser profile at `./auth/ibny/` (first AI Studio sign-in).
- An rclone remote named `ibny:` (config `./auth/ibny/rclone.conf`).
- Optional Notion credentials at `./notion.json` (see §8).
- Optional backup Google account: `bun login.js <name>` creates
  `./auth/<name>/`. It needs no rclone remote — only the browser profile.

---

## 2. Quick start

1. In the browser (or any app), copy a **name clip** line, e.g.
   `Phy Udv P2 Ch4` — then copy the lecture URLs **in order** (newest last).
2. Run:

   ```bash
   zaknotes                 # default account: ibny
   ```

   or directly:

   ```bash
   cd ~/testAiStudio && bun batch.js
   ```

3. Notes land in `notes/<name>.md`, audio is archived to Drive `Classes/`,
   and each note is pushed to Notion (if configured).

`zaknotes --help` (or `bun batch.js --help`) prints this guide.

---

## 3. Naming convention

Clipboard is read newest-first from the clipboard-indicator registry. A **name
clip** is any non-URL line `Subject Instructor Paper Chapter`
(e.g. `Phy Udv P2 Ch4`, `HM Udv P2 Ch4`). The first word is the Subject
(`Phy`, `Chem`, `Bio`, `HM`, `Math`, …).

Each URL after a clip is named `<clip> 01`, `<clip> 02`, … (space-joined, so the
number never merges with the chapter). A new clip restarts at `01`. A trailing
number in the clip (e.g. `Phy Udv P2 Ch4 04`) sets the **starting index**.

That name becomes the archived filename, the note filename, and the Notion page
title. URLs copied without a clip keep the legacy behaviour (audio only).

---

## 4. Resume, reuse & interrupted downloads

Zaknotes never redoes work that is already done.

- **Resume (on by default).** A lecture is skipped when its note already exists
  as `notes/<name>.md` **and validates** (see §6), or as a page in Notion
  (matched by title). A tiny/truncated local note is regenerated instead of
  being trusted.
  - `--force` — regenerate anyway.
  - `--no-resume` — disable the check (also settable as `"resume": false`).
- **Archive reuse.** If `<name>.<ext>` already exists in the Drive archive,
  yt-dlp is skipped and the existing Drive copy is re-linked.
- **Download reuse.** Media downloaded by an earlier run is kept in
  `tmp/<account>/downloads/` and reused instead of being fetched again.
- **Interrupted downloads are never trusted.** `runPlan` writes
  `<name>.download.inprogress` before yt-dlp starts and `<file>.complete` after
  it exits 0. A file is reused only when it is non-zero, has no `.part`/`.ytdl`
  sibling, has no in-progress marker, and is not a half-finished
  webm→mp3 conversion. After Ctrl+C the leftovers are deleted and the next run
  downloads the whole file again (there is no `--no-part` any more).
- **Expired signed links** (Apars `?exp=`) already dead are skipped with a
  warning instead of 403-spamming; re-copy them just before running.

---

## 5. Duration-based chunking

A long lecture is split into equal-duration parts:

```
count = ceil(duration / maxMinutes)
each  = duration / count
```

| Setting | Default |
| --- | --- |
| `chunking.maxMinutes` | `120` |
| `chunking.ceilingMinutes` (hard cap) | `150` |
| `chunking.genTimeoutMin` (per part) | `20` |
| `chunking.retryAttempts` | `2` |

Examples: 90 min → 1 part; 210 min → 2 × 105 min; 300 min → 3 × 100 min.
`--chunk-minutes 90` gives a conservative split; `--no-chunk` disables
splitting.

- Parts are cut with `ffmpeg` (stream copy, audio re-encode fallback) under
  `tmp/<account>/chunks/`.
- Part notes are cached in `notes/.parts/<name>/part-NN.md` with a manifest of
  duration + chunk config. Successful parts are reused on the next run; a failed
  part stays failed so a retry reuses the same boundaries (no auto-halving).
- The final note is merged from the part notes, validated as a whole, and only
  then written and pushed to Notion. A lecture with a failed part is not pushed
  at all.
- Each part gets a `<lecture_part>` instruction suffix so the model transcribes
  only that segment, without an artificial intro/outro.

### Slides with chunks

The slide PDF is normally attached whole to every part. It is split into equal
page ranges only when it is larger than `chunking.slidesMaxPages` (`40`) or
`chunking.slidesMaxMB` (`12`); then part N gets page range N of the split. A
single-part lecture never splits slides.

---

## 6. Note validation

A response is saved only when it passes structural validation
(`lib/validate.js`):

- at least `minNoteChars` (default `400`) characters of real content;
- no site error page, verification/quota notice, terminal log, or clipboard UI
  fragment (`editmore_vert`, `thumb_upthumb_down 9m38s`);
- balanced `$$` and inline `$` math, closed code fences, no final line cut
  mid-table/mid-bold/mid-math/mid-code, no heading-only ending;
- not a **thinking trace**: AI Studio renders a reasoning model's trace in its
  own panel, and "Copy as markdown" can copy that panel instead of the answer.
  A trace is first-person present-tense English planning ("I'm now focusing
  on…", "The user wants…") under bold headings, so a note is rejected when
  planning sentences dominate. Measured across the archive: real notes score
  ≤1%, traces 22–70%.

A truncated/invalid response is a **failed part**, never a success, so resume
will try it again. Clipboard UI chrome is stripped automatically
(`scrubNoteArtifacts`) before saving.

---

## 7. Accounts & model fallback

Downloads, uploads and the Drive archive always stay on the **primary**
account. A backup account supplies only its browser profile: the public Drive
link is readable from any signed-in Google account.

Configure with `config.json`:

```json
{
  "account": "ibny",
  "accounts": { "strategy": "on-failure", "backups": ["backup"] },
  "model": "gemini-4-hydrogen",
  "modelFallbacks": ["gemini-3.8-flash"]
}
```

- `accounts.strategy` — `on-failure` (default) keeps the primary first;
  `round-robin` rotates the starting account per lecture.
- `accounts.backups` is a list: add as many profiles as you have
  (`["backup", "backup2"]`). Each backup needs only `auth/<name>/`; the primary
  still owns downloads, uploads, and the Drive archive.
- `--backup-account NAME` / `--no-backup` override the list for one run.
- `bun doctor.js accounts` marks a configured backup whose profile is missing
  and prints the `bun login.js <name>` command to create it.
- Model order: configured model → `modelFallbacks` → built-in chain.
- Failure policy (aligned with Google's
  [API error codes](https://ai.google.dev/gemini-api/docs/api-errors)):
  - `verification` → account unusable, next account;
  - `permission` (403) / `payment` (402) → this account cannot use the model,
    next account;
  - `quota` (daily/quota exceeded) → next model, then next account;
  - `rate_limit` (429/RESOURCE_EXHAUSTED, per-minute) → back off, next model,
    then next account;
  - `model_missing` (404/MODEL_NOT_FOUND) → next model;
  - `server` (500/503/504) → retry the same model with exponential backoff;
  - `context` (input too long) / `max_tokens` (MAX_TOKENS) → next model;
  - `safety` / `prohibited_content` / `spii` → next model;
  - `location`, `language`, `invalid_request` → fatal: no account/model change
    can help, so the lecture fails with an explicit reason instead of retrying;
  - file load failure → next account;
  - truncated/invalid note → next model;
  - **recitation/copyright block** → retry the same model (the block is
    stochastic and usually passes), then the next model, then the next account.
    Nothing is copied or saved from a blocked turn.
  - `unknown` → retry, then next model/account.
  Each failure logs an actionable hint (e.g. "daily quota exhausted; trying
  another model, then account").
- `latest-flash` still works and resolves the live `gemini-flash-latest` alias.
  The default is pinned to `gemini-4-hydrogen`. `bun config.js models` lists the
  live picker and shows what each alias points at.

---

## 8. Configuration & credentials

- `config.json` (gitignored) — tunables. Manage with `bun config.js`
  (`bun config.js get`, `set key value`, `unset key`, `show`). Defaults live in
  `lib/config.js`; a template is `config.json.example`.
- `notion.json` (gitignored) — Notion `token` + `databaseId` (or `pageId`), or
  env `NOTION_TOKEN` / `NOTION_DATABASE_ID` / `NOTION_PAGE_ID`. Target DB:
  **ZakNotes**.
- Browser profiles live under `auth/<account>/`; rclone config is
  `auth/<account>/rclone.conf`.

Notion payloads are batched conservatively: ≤100 blocks, ≤900 block elements,
≤100 rich-text objects per block, ≤450 KB per request; inline-heavy paragraphs
are split across consecutive blocks, tables longer than 90 rows are split with
the header repeated; equations longer than 1000 chars fall back to a `latex`
code block; URLs longer than 2000 chars are truncated or downgraded to text.

---

## 9. Doctor (audit / repair / cleanup)

```bash
bun doctor.js audit [--json]
bun doctor.js scrub [--yes]
bun doctor.js salvage [--yes] [--names a,b] [--notion]
bun doctor.js repair [--yes] [--dry-run] [--only severe|tiny|all] [--names a,b] [--wait MIN]
bun doctor.js cleanup [--yes] [--drive]
bun doctor.js notion-dedupe [--yes]
bun doctor.js notion-sync [--yes] [--replace] [--names a,b]
bun doctor.js accounts
bun doctor.js models
```

- **audit** — validates every note, lists download leftovers and zero-byte
  files, and reports notes that only carry clipboard UI chrome.
- **scrub** — rewrites notes in place to drop `editmore_vert` /
  `thumb_upthumb_down 9m38.2s` chrome (no regeneration).
- **salvage** — media-free repair for notes whose recording is gone: drops a
  dangling final list item/heading, closes a code fence left open at EOF, and
  removes a stray `$$` the model left in prose. It never invents text, so a
  note cut mid-sentence stays invalid and is reported. `--notion` pushes the
  patched note and archives the old page only after the patch validates.
- **repair** — for every invalid note: restores the archived Drive copy (or a
  surviving local download), regenerates it through the normal chunk/fallback
  pipeline, validates the result, and only then archives the old Notion page.
  Old notes are moved to `notes/.repair-backup/` and restored if regeneration
  fails. Media is passed to `batch.js` through a `name<TAB>path<TAB>remote`
  manifest (`--media-file`), so no source URL is needed. If another run already
  holds the account's browser profile (a live `batch.js`), repair stops before
  restoring anything; `--wait 120` queues it instead and starts as soon as the
  lock is released.
- **cleanup** — deletes partial/zero-byte downloads and local media whose
  lecture already has a valid note. `--drive` also removes interrupted
  `.part`/`.ytdl`/`.inprogress` and zero-byte objects from the Drive archive;
  complete recordings are kept as the repair source. `--drive-noted` is the
  aggressive opt-in that also deletes archived media for already-noted
  lectures. Destructive commands are dry-run unless `--yes` is passed.
- **notion-dedupe** — archives older duplicate pages, keeping the newest.
- **notion-sync** — pushes valid local notes that are missing from Notion.
  `--replace` re-pushes the selected notes (or all valid ones with `--names`)
  and archives the old page only after the new page exists.
- **accounts** — shows profiles, configured backups, strategy and model.

---

## 10. Options

```
bun batch.js [account] [flags]        (wrapper: zaknotes [flags])
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `[account]` | `ibny` | which profile/remote to use |
| `--file FILE` | clipboard | read URLs from a file instead of the clipboard |
| `--media-file FILE` | – | `name<TAB>path[<TAB>remote]` manifest; process local/restored media (used by repair) |
| `--dry-run` | – | print the plan (report + yt-dlp commands), do nothing |
| `--limit N` | all | process only the first N lectures |
| `--gen-timeout MIN` | `10` | absolute ceiling on one full-lecture generation |
| `--jobs N` | `1` | generate N notes in parallel tabs (2-4; each tab starts on a different model) |
| `--chunk-minutes MIN` | `120` | split lectures longer than this |
| `--chunk` / `--no-chunk` | on | enable/disable duration chunking |
| `--min-note-chars N` | `400` | minimum accepted note size |
| `--show` / `--minimize` / `--tile` / `--headless` | `minimize` | browser window mode |
| `--model SLUG\|latest-flash` | `gemini-4-hydrogen` | AI Studio model; `latest-flash` auto-detects the newest Flash |
| `--resume` / `--no-resume` | on | skip already-noted lectures |
| `--force` | off | regenerate even if the note exists |
| `--no-archive` | – | do not keep uploads (temp `uploads/`, deleted) |
| `--no-reuse` | – | ignore the Drive archive when planning |
| `--by-subject` | off | archive under `Classes/<Subject>/` |
| `--remote-path FOLDER` | `Classes` | archive folder |
| `--notes-dir DIR` | `./notes` | where notes are written |
| `--keep-local` | off | keep downloaded audio after a note |
| `--no-slides` | – | skip slide PDFs |
| `--slides-root DIR` | HSC/pdf drive | slide library root |
| `--no-notion` | – | do not push notes to Notion |
| `--clean-audio` / `--no-clean-audio` | off | ffmpeg loudnorm before upload |
| `--backup-account NAME` / `--no-backup` | config | fallback account when the primary fails |
| `--help`, `-h` | – | print this guide |

Any flag not given falls back to `config.json`.

---

## 11. Output & state

- `notes/<name>.md` — the generated note.
- `notes/.parts/<name>/` — cached part notes + manifest (safe to delete; the
  lecture is then regenerated in full).
- `notes/.repair-backup/` — pre-repair notes, restored on failure.
- `Classes/` (Drive) — archived audio + slide PDFs.
- `state/history.jsonl` — one record per processed lecture (includes `chunks`
  and `reusedParts`).
- `state/counters.json` — cumulative totals (notes ok/failed, chars, per-model).
- `state/<account>.lock` — one run per account; a second concurrent run is
  refused (an interrupted run holds the lock until it exits).

### Speed: parallel tabs (`--jobs`)

Generation is the slow part (2-6 minutes per 60-120 minute part), so the wall
time is almost entirely waiting. `--jobs N` runs N notes at once in N tabs of
one browser, the same way you would do it by hand:

```bash
bun batch.js --jobs 3
```

- Each lane starts on a **different model** (`gemini-4-hydrogen`,
  `gemini-3.8-flash`, `gemini-flash-latest`) because Google's rate limit is per
  model — spreading lanes is what makes tabs faster instead of just hitting the
  same limit three times.
- Uploads/splits use one account lock, so they never collide; only generation
  overlaps. Clipboard attach/copy steps are serialized automatically (one OS
  clipboard, one tab at a time).
- 3 is the practical limit on an 8 GB machine; the cap is 4. More tabs also
  increase the chance of a Google-side rate limit, which is retried on the next
  model anyway.
- A crashed tab is closed and recreated; progress and part caches are shared, so
  a failure in one lane never loses another lane's finished parts.

Set it once with `"jobs": 3` in `config.json`, or use `--jobs 1` to return to
strictly sequential.

---

## 12. How generation completion is detected

The copy step happens only after generation has **actually finished**: the
site's "Stop" button disappears, "Run" returns, and that state holds steady with
no new output. Completion is never decided by elapsed time or a character count.
`genTimeoutMin` (default 10 for a whole lecture, `chunking.genTimeoutMin` = 20
for a part) is the absolute ceiling before the attempt is retried/failed. A
**stall detector** fails an attempt much sooner: a live generation keeps adding
text (even the thinking trace), so 6 minutes with zero growth means the turn is
dead (usually a silent rate limit). A hard watchdog closes the browser 4 minutes
after `genTimeoutMin` if a CDP call wedges.

### Desktop freeze protection

A long, stalled AI Studio turn can grow a Chromium renderer until the desktop
starts thrashing and freezes. Several layers now prevent the browser from taking
the machine down with it:

- **No layout-forcing reads while polling.** Completion/error polling uses
  `textContent`, never `innerText`; a layout read on a 100k-character streaming
  turn re-lays out the whole chat on every poll. The poll interval also grows
  (2 s → 5 s → 8 s) as the turn gets larger, and every page read has its own
  timeout, so a wedged CDP call fails the attempt instead of hanging.
- **Low OS priority.** The browser and all of its renderer/GPU/utility children
  are re-niced to 15 with idle I/O (`renice`/`ionice`; set `ZS_BROWSER_NICE=0`
  to disable). A runaway renderer can no longer starve your desktop.
- **Disk-backed browser temp.** `/tmp` is a tmpfs on many Linux setups, and
  Playwright's default `--disable-dev-shm-usage` puts Chromium's shared memory
  there — i.e. in RAM. Browser temp now goes to `./tmp/browser-tmp` on disk.
- **Memory guard.** Before a launch (and before each extra `--jobs` tab) the
  run checks `MemAvailable`/swap. If RAM is below `ZS_MIN_FREE_MB` (default
  1000) or swap below `ZS_MIN_SWAP_MB` (default 128), it reaps leftover
  browsers, waits up to 90 s, then fails the lecture with a clear message instead
  of freezing the machine. The generation poll loop also aborts a turn when RAM
  drops below `ZS_ABORT_FREE_MB` (default 300) or when swap is nearly exhausted;
  the browser is closed immediately, releasing the memory.
- **Background throttling re-enabled.** Playwright normally keeps minimized /
  occluded renders at full priority and disables Chromium's IPC-flood
  protection. Those defaults are dropped so a minimized tab is throttled and a
  renderer cannot flood the browser process.
- **Hard kill and orphan reaping.** `Ctrl+C` and a timed-out attempt escalate
  from `SIGTERM` to `SIGKILL` after a few seconds, and each run kills Chromium
  processes left behind by an earlier crash (only this repo's profiles) before
  starting.

Quota/rate-limit/verification/missing-model failures are **not** retried on the
same account and model — a fresh browser cannot clear them. They go straight to
the model chain and then the backup account, which saves a launch + attach cycle
per retry. Transient 5xx errors do retry the same model with backoff, as Google
recommends.

Notes are sanitized on save: native-script prose the model may have placed inside
math (`$...\text{বাংলা}...$`) is removed, because KaTeX can't render it and would
otherwise show parse errors in Notion/preview.

---

## 13. Recitation ("Full output blocked") blocks

Google's **recitation filter** stops a response when it closely matches text the
model memorised. It fires on public, non-infringing lectures too: a definition
or worked example that exists word-for-word in a common textbook is exactly the
kind of text it looks for. The block is stochastic — the same prompt often
passes on the next attempt — so it is handled as a retryable condition, not a
refusal:

- the notice is read from the page and classified as `recitation`, so a blocked
  turn can never be copied, saved, or pushed to Notion;
- the same model is retried (fresh browser), then the next model, then the
  backup account;
- `system_instructions.md` tells the model to **write explanations in its own
  words** instead of reciting published passages, which reduces how often the
  filter trips while keeping terms, formulas, and exam labels intact.

You can strengthen the effect by editing the `<original_wording>` section of
`system_instructions.md`. If blocks are frequent on one lecture, rerun it later:
the same input often succeeds without any change.

---

## 14. Troubleshooting

- **"Copy as markdown" did not update the clipboard** — the site's copy is a
  browser-to-OS-clipboard write and can be denied if the window lost focus. The
  run retries the click; if it still fails it recovers the note from the rendered
  response (DOM) so a finished generation is never lost, and only then retries the
  lecture. Keep the window un-minimized (`--show`) if it recurs.
- **A pasted image/other file got attached instead of the Drive link** — the
  attach step uses a real Ctrl+V, which reads the shared OS clipboard, so a
  denied write or a copy from another app could attach the wrong item. The paste
  is now wrapped in an in-page guard: if the clipboard does not actually carry
  the Drive link we just wrote, the event is cancelled before AI Studio sees it
  and the link is attached through a clipboard-free DOM paste instead. If a chip
  still turns out to be an image, the run fails loudly and retries rather than
  generating from the wrong file. Your clipboard contents are restored
  afterwards.
- **The note is the model's thinking, not the answer** — the answer's action
  menu is used (never the thinking panel's), the copied text is checked for
  first-person planning, and the rendered answer (thinking panels excluded) is
  used as a fallback. If a trace still slips through, validation rejects it
  (`reasoning-trace`), so it can never be saved or pushed; `bun doctor.js
  repair` regenerates it.
- **"Another run is already active …"** — a previous run is still alive or left
  a stale lock. Finish/close it, or remove `state/<account>.lock` when no
  `bun batch.js` process is running.
- **Profile "already in use"** — a leftover Chromium holds `auth/<account>/`.
  Close it; Zaknotes also reaps stale browsers on launch.
- **Signed link expired** — re-copy the Apars URLs from the site and re-run.
- **Every account tried, all failed** — the log names the failure `kind`
  (`verification`, `quota`, `rate_limit`, `model_missing`, `file_load`,
  `truncated`). `bun doctor.js accounts` and `bun config.js models` confirm the
  configured profiles and models.
- **A lecture is stuck as invalid** — `bun doctor.js audit` shows the exact
  validation codes; `bun doctor.js repair --dry-run` shows whether archived
  media is available to regenerate it.
