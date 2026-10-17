# Zaknotes v2

Clipboard URLs → yt-dlp download → rclone Drive link → Google AI Studio note,
saved to `notes/` and pushed to Notion. One command, no intermediate Drive
re-download.

Replaces the old `batch-notes` / `batch-dl` scripts.

---

## 1. Requirements

| Tool | Purpose |
| --- | --- |
| [Bun](https://bun.sh) | runtime (all scripts are `bun *.js`) |
| `yt-dlp` | media download (YouTube / Apars m3u8) |
| `rclone` | upload to the `ibny:` remote and mint a public link |
| CloakBrowser (`cloakbrowser`) | managed Chromium used for AI Studio |
| `ffmpeg` | optional audio loudness-normalisation (`--clean-audio`) |

One-time setup:

- A logged-in browser profile at `./auth/ibny/` (first AI Studio sign-in).
- An rclone remote named `ibny:` (config `./auth/ibny/rclone.conf`).
- Optional Notion credentials at `./notion.json` (see §7).

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

## 4. Resume & reuse (the important part)

Zaknotes never redoes work that is already done.

- **Resume (on by default).** A lecture is skipped when its note already exists
  as `notes/<name>.md` **or** as a page in Notion (matched by title).
  - `--force` — regenerate anyway.
  - `--no-resume` — disable the check (also settable as `"resume": false`).
- **Archive reuse.** If `<name>.<ext>` already exists in the Drive archive,
  yt-dlp is skipped and the existing Drive copy is re-linked.
- **Download reuse.** Media downloaded by an earlier run is kept in
  `tmp/<account>/downloads/` and reused instead of being fetched again, so an
  interrupted run does not re-download completed lectures. A `.part`/`.ytdl`
  sibling marks an unfinished file and is never reused.
- **Expired signed links** (Apars `?exp=`) already dead are skipped with a
  warning instead of 403-spamming; re-copy them just before running.

---

## 5. Slides

Each named lecture can attach its slide PDF after the audio (improves notes).
The clip's chapter is resolved under `--slides-root` (default the HSC/pdf
drive), then the NN-th PDF (PDFs only, natural order) from the chapter's
`Slides/`/`Notes/` folder is used, uploaded next to the audio as `<name>.pdf`,
and attached. Disable with `--no-slides`; only the downloaded audio is ever
deleted, never the source PDF.

---

## 6. Options

```
bun batch.js [account] [flags]        (wrapper: zaknotes [flags])
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `[account]` | `ibny` | which profile/remote to use |
| `--file FILE` | clipboard | read URLs from a file instead of the clipboard |
| `--dry-run` | – | print the plan (report + yt-dlp commands), do nothing |
| `--limit N` | all | process only the first N lectures |
| `--gen-timeout MIN` | `10` | absolute ceiling on one generation wait |
| `--show` / `--minimize` / `--tile` / `--headless` | `minimize` | browser window mode |
| `--model SLUG\|latest-flash` | `latest-flash` | AI Studio model; `latest-flash` auto-detects the newest Flash |
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
| `--backup-account NAME` / `--no-backup` | off | fallback account when the primary fails |
| `--help`, `-h` | – | print this guide |

Any flag not given falls back to `config.json`.

---

## 7. Configuration & credentials

- `config.json` (gitignored) — tunables. Manage with `bun config.js`
  (`bun config.js get`, `set key value`, `unset key`, `list`). Defaults live in
  `lib/config.js`; a template is `config.json.example`. Key default:
  `genTimeoutMin: 10`.
- `notion.json` (gitignored) — Notion `token` + `databaseId` (or `pageId`), or
  env `NOTION_TOKEN` / `NOTION_DATABASE_ID` / `NOTION_PAGE_ID`. Target DB:
  **ZakNotes**.
- Browser profiles live under `auth/<account>/`; rclone config is
  `auth/<account>/rclone.conf`.

---

## 8. Output & state

- `notes/<name>.md` — the generated note.
- `Classes/` (Drive) — archived audio + slide PDFs.
- `state/history.jsonl` — one record per processed lecture.
- `state/counters.json` — cumulative totals (notes ok/failed, chars, per-model).
- `state/<account>.lock` — one run per account; a second concurrent run is
  refused (an interrupted run holds the lock until it exits).

---

## 9. How generation completion is detected

The copy step happens only after generation has **actually finished**: the
site's "Stop" button disappears, "Run" returns, and that state holds steady with
no new output. There is no character- or time-based early exit. `genTimeoutMin`
(default 10) is only the absolute ceiling before a lecture is retried/failed.

Notes are sanitized on save: native-script prose the model may have placed inside
math (`$...\text{বাংলা}...$`) is removed, because KaTeX can't render it and would
otherwise show parse errors in Notion/preview.

---

## 10. Troubleshooting

- **"Copy as markdown" did not update the clipboard** — the site's copy is a
  browser-to-OS-clipboard write and can be denied if the window lost focus. The
  run retries the click; if it still fails it recovers the note from the rendered
  response (DOM) so a finished generation is never lost, and only then retries the
  lecture. Keep the window un-minimized (`--show`) if it recurs.
- **"Another run is already active …"** — a previous run is still alive or left
  a stale lock. Finish/close it, or remove `state/<account>.lock` when no
  `bun batch.js` process is running.
- **Profile "already in use"** — a leftover Chromium holds `auth/<account>/`.
  Close it; Zaknotes also reaps stale browsers on launch.
- **Signed link expired** — re-copy the Apars URLs from the site and re-run.
