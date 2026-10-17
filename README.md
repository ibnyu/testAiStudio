# AI Studio Study Notes

Turn local files into study-ready notes with Google AI Studio — one command per
file, isolated per Google account.

For each run the script uploads your file to that account's Google Drive,
attaches it to a fresh AI Studio chat (model `gemini-3.8-flash`), applies your
global system instructions, waits for the response, copies it as Markdown, and
saves it to `./notes/<input-name>.md`. Input files are cleaned up afterwards.

## How it works

One account name drives **both** the browser profile and the Drive remote:

| Concern          | Location                        |
| ---------------- | ------------------------------- |
| Browser profile  | `./auth/<account>/`             |
| Portable rclone config | `./auth/<account>/rclone.conf` (remote named `<account>:`) |
| Staging / temp   | `./tmp/<account>/` (cleaned every run) |
| Study notes      | `./notes/<input-name>.md` (global, kept) |
| System instructions | `./system_instructions.md` (global file) |

Pipeline per run (`bun main.js <account> <local-file> [remote-path]`):

1. **Dedup check** — `rclone lsjson` on the exact Drive dest; byte-identical
   file already there → skip upload, reuse link.
2. **Clean + stage** — `./tmp/<account>/` created or emptied, file copied in.
3. **Upload + public link** — `rclone copyto`, then `rclone link`.
4. **AI Studio chat** — headed browser (default) with the account's profile:
   new chat → set system instructions (autosaves on pause) → paste Drive link
   (attaches as a file chip, e.g. `probe.txt · 12 tokens`) → wait until the
   chip shows a token count → Run.
5. **Wait + copy** — done = Stop button gone + Run back + text stable;
   then *Open options → Copy as markdown* via clipboard.
6. **Save + clean** — note written, read back, and only if non-empty the
   staged copy, the **original input file**, and the Drive file are deleted.

Transient Google-side flakes (e.g. the red *"failed to load file"* popup) are
retried automatically: the browser is closed and the flow restarts from a fresh
chat, up to 3 attempts.

> ⚠️ **Destructive by design:** on success the original input file is deleted
> from disk and its Drive copy removed. Keep backups of anything irreplaceable.

## Prerequisites

- [Bun](https://bun.sh) (tested on 1.4.x)
- [rclone](https://rclone.org) (tested on 1.75.x)
- A Google account per profile you want to use
- Linux with a display for headed runs (or `--headless`)

## Install

```bash
bun install
```

`cloakbrowser` downloads its own Chromium on first launch
(cached at `~/.cloakbrowser/`). Do **not** `playwright install chromium`.

## Add an account

Repeat once per Google account. Example account name: `ridoy`.

**1. Browser login** (headed — sign in manually):

```bash
bun login.js ridoy
```

A browser opens on Google's sign-in page. Sign in, then press Enter in the
terminal. Cookies persist in `./auth/ridoy/`.

**2. Drive remote** (portable config, gitignored):

```bash
rclone --config ./auth/ridoy/rclone.conf config
```

- `n` new → name it exactly `ridoy` → Storage `drive`
- `client_id` / `client_secret`: blank
- scope `1` (full access — needed for upload + public links)
- `root_folder_id` / `service_account_file`: blank
- advanced `n` → auto config `y` → authorize the **same** Google account
- `y` OK → `q` quit

Verify:

```bash
rclone --config ./auth/ridoy/rclone.conf listremotes   # expect: ridoy:
rclone --config ./auth/ridoy/rclone.conf lsd ridoy:
```

> rclone warns its shared Drive `client_id` retires during 2026 — if uploads
> start failing, create your own client ID per the rclone Drive docs.

**3. System instructions** (one global file for all accounts):

```bash
cat ./system_instructions.md   # created with a default on first run
```

Edit it — it is pasted into every chat's *System instructions* card.

## Usage

```bash
# Headed (default, recommended for login-bound flows)
bun main.js ridoy /path/to/lecture.pdf

# Custom Drive folder + headless + longer generation timeout
bun main.js ridoy /path/to/lecture.pdf course/week3 --headless --gen-timeout 45
```

| Arg / flag | Meaning |
| ---------- | ------- |
| `<account>` | Browser profile `./auth/<account>/` **and** rclone remote `<account>:` |
| `<local-file>` | File to upload. **Deleted after a confirmed note.** |
| `[remote-path]` | Drive folder (default `uploads/`) |
| `--headless` | Hide the browser (no window) |
| `--minimize` | Headed, window minimized via CDP (default for `batch.js`) |
| `--tile` | Headed, small window in the corner |
| `--show` | Headed, left where the window manager places it (default for `main.js`) |
| `--gen-timeout <minutes>` | Max generation wait (default 30; long audio notes need 5–10+) |
| `--no-notion` | Skip the Notion upload for this run |

Outputs:

- `./notes/<input-name-without-ext>.md` — the study note
- `./tmp/<account>/upload.json`, `drive_link.txt` — run metadata (staging dir)

## Batch mode (`batch.js`)

`batch.js` is a one-command front end that goes from **clipboard URLs to
notes**: it reads the newest batch of URLs from the clipboard-indicator
registry, downloads them with `yt-dlp`, archives each to Drive once, and
generates a study note per file. There is no intermediate Drive
re-download — each file is uploaded exactly once and that same public link
feeds AI Studio.

```bash
# Process the current clipboard batch (account defaults to ibny)
bun batch.js

# Preview the yt-dlp commands without downloading
bun batch.js --dry-run

# Explicit account, URL list, visible browser, first file only
bun batch.js ibny --file urls.txt --show --limit 1
```

| Flag | Meaning |
| ---- | ------- |
| `[account]` | Browser profile + rclone remote (default `ibny`) |
| `--file <urls.txt>` | Read URLs from a file instead of clipboard history |
| `--dry-run` | Print the plan / yt-dlp commands only |
| `--limit <n>` | Process only the first `n` URLs |
| `--gen-timeout <min>` | Max generation wait per file (default 30) |
| `--minimize` / `--tile` / `--show` / `--headless` | Browser window mode (default `minimize`) |
| `--no-archive` | Upload to temp `uploads/` and delete after the note instead of keeping the archive |
| `--by-subject` | Archive under `Classes/<Subject>/` instead of flat `Classes/` |
| `--keep-local` | Keep the downloaded audio after the note is saved |
| `--remote-path <folder>` | Archive folder (default `Classes`) |
| `--notes-dir <dir>` | Notes output folder (default `./notes`) |
| `--no-slides` | Do not attach slide PDFs (audio only) |
| `--slides-root <dir>` | Slide library root (default the `HSC/pdf` drive; env `SLIDES_ROOT`) |
| `--no-notion` | Skip the Notion upload for this run |

### Naming lecture series

Copy a **name clip** just before a run of URLs. The clip follows the pattern
`Subject Instructor Paper Chapter`, where the Subject is simply the first word
(`Phy`, `Chem`, `Bio`, `HM`, `Math`, ...), e.g. `Phy Udv P2 Ch4`. The script
numbers that run automatically, joining the number with a space so it never
merges with the chapter:

```
clip: Phy Udv P2 Ch4
  ... url 1   ->  Phy Udv P2 Ch4 01
  ... url 2   ->  Phy Udv P2 Ch4 02
clip: Phy Mashrur P2 Ch6        # a new clip restarts the run at 01
  ... url 1   ->  Phy Mashrur P2 Ch6 01
```

- The generated name becomes the **archived filename**, the **note filename**,
  and the **Notion page title**. The note body keeps the model's own heading.
- A clip ending in a bare number (e.g. `Phy Udv P2 Ch4 04`) starts numbering
  there instead of `01`.
- URLs copied **without** a clip keep the old behaviour (yt-dlp title /
  subject-prefixed archive names).
- Clips and URLs can span different kinds (YouTube and Apar) in one clipboard
  batch; each group is classified and downloaded independently.

### Slide PDFs (audio + slides)

Each named lecture is also given its matching **slide PDF**, uploaded to Drive
right after the audio (both under the same base name, e.g. `Phy Udv P2 Ch4 01.mp3`
and `Phy Udv P2 Ch4 01.pdf`) and attached to the same prompt. Feeding both the
audio and the slides produces markedly better notes.

The clip's `Subject Instructor Paper Chapter` is resolved to a folder under the
slide root (default the mounted `HSC/pdf` library):

```
<slides root>/<Subject>/<Instructor>/<Paper>/<Chapter>/
```

- Folder names are matched alias-aware, so `Phy`/`Physics`, `P1`/`Paper 1` and
  `Ch4`/`Chapter 4` all work — no renaming needed.
- Lecture `NN` uses the **NN-th PDF** in the chapter's `Slides` (or `Notes`)
  folder, in natural order. Only `*.pdf` files are used.
- If a chapter folder has no `Slides`/`Notes` subfolder, its own PDFs are used;
  if the folder can't be found or has too few PDFs, that lecture gets audio only
  and a warning is printed.
- `--dry-run` prints the resolved folder and the exact slide for every lecture
  so the pairing can be verified before anything is downloaded.

Behaviour matches the original `batch-dl`: files are classified as
AparClassroom (iframe / `.m3u8`, routed to `Biology`/`Chemistry`/`Physics`/
`Maths`/`Streams` by filename pattern) or YouTube, downloaded as mp3, uploaded
once to Drive, and the local copy is deleted after a non-empty note is saved.
The Drive archive is kept.

## Notion export

Generated notes are mirrored into Notion automatically when configured. Math
renders as **native equation blocks** and ` ```mermaid ` fences render as
**diagrams** — there is no manual "select the text and turn it into an equation"
step, because the Markdown is converted into real Notion block objects before
upload.

1. Create an internal integration at <https://www.notion.so/my-integrations>
   and copy its token.
2. Create (or open) the database you want notes in, then share it with the
   integration: **••• → Connections → your integration**.
3. Copy the database ID — the 32-character id in the page URL.

Configure `./notion.json` (gitignored):

```json
{
  "enabled": true,
  "token": "ntn_...",
  "databaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

Environment variables override the file: `NOTION_TOKEN`, `NOTION_DATABASE_ID`,
`NOTION_PAGE_ID`. Use `pageId` instead of `databaseId` to create notes as child
pages. A Notion failure never deletes the local note. Disable per run with
`--no-notion`.

| Markdown | Notion block |
| -------- | ------------ |
| `$$...$$` | `equation` block (KaTeX) |
| `$...$` | inline `equation` rich text |
| ` ```mermaid ` | `code` block, language `mermaid` (renders a diagram) |
| `#` / `##` / `###` | `heading_1` / `heading_2` / `heading_3` |
| `-` / `1.` / `- [ ]` | bulleted / numbered / to-do lists (nested) |
| `\| a \| b \|` | `table` with `table_row` children |
| `![alt](url)` | `image` (external URL) |
| `---` | `divider` |
| `> quote` | `quote` |

## Project layout

```text
login.js               manual Google sign-in per account (./auth/<name>/)
main.js                single-file pipeline: dedup → upload → chat → notes → cleanup
batch.js               batch pipeline: clipboard URLs → yt-dlp → archive → notes
lib/account.js         one-name account resolution, rclone helpers, stale-browser kill
lib/aistudio.js        AI Studio selectors/flow (paste, load gate, wait, copy)
lib/pipeline.js        shared upload/link + note generation used by main.js and batch.js
lib/batchdl.js         clipboard URL parsing + yt-dlp planning/run (ported from batch-dl)
lib/slides.js          resolve a clip to its chapter folder + ordered slide PDFs
lib/notion.js          Markdown -> Notion blocks (equations, mermaid, tables) + upload
notion.json.example    template for Notion token + database id (copy to notion.json)
system_instructions.md global system instructions (tracked; edit freely)
auth/                  gitignored browser profiles + portable rclone.conf per account
tmp/                   gitignored per-account staging (cleaned every run)
notes/                 gitignored generated study notes
```

Key selectors (verified against the live site, see `lib/aistudio.js`):

- Prompt box `textarea[aria-label="Enter a prompt"]`, Run/Stop buttons by label
- System instructions live in the **Run settings panel**:
  `button[aria-label="Toggle run settings panel"]` → `[data-test-system-instructions-card]`
  → `textarea[aria-label="System instructions"]`
- Drive-link paste attaches `ms-prompt-media` (`ms-prompt-file` chip);
  loaded = chip shows `\d+ tokens`, loading = `Loading...`
- Latest response: last `ms-chat-turn` → hover → *Open options* →
  *Copy as markdown* → clipboard

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `profile is already in use` | Another Chromium holds `./auth/<name>/`. Close it; the script auto-kills its own stale PIDs on retry. Never open two runs on the same account. |
| `Rclone remote "x:" not found` | Remote missing in that account's config — re-run step 2 with the exact account name. |
| `Rclone config ... not found` | Per-account `rclone.conf` missing — re-run step 2 with `--config ./auth/<name>/rclone.conf`. |
| Red *failed to load file* popup | Google-side Drive fetch flake — retried automatically (fresh browser, up to 3 attempts). |
| `Run button stayed disabled` | File still loading (large files take 5+ min) — the script waits for the token-count chip first. |
| `Timed out waiting for generation` | Raised default is 30 min; pass `--gen-timeout <minutes>` for longer. |
| Empty-note error | Nothing deleted; fix (`system_instructions.md` empty? generation failed?) and re-run. |
| Paste lands as plain text | The script pastes via trusted clipboard (`Ctrl+V`) and waits for the `ms-prompt-media` chip, falling back to a synthetic paste event. |

## Privacy

`auth/` (cookies, Drive tokens), `tmp/`, `notes/`, and `stage/` are gitignored.
Never commit `./auth/*/rclone.conf` — it holds Drive OAuth tokens.
