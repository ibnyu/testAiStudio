// Note integrity validation.
//
// A finished generation can still be unusable: the site's "copy as markdown"
// may return a UI fragment, a verification/quota error page, a terminal log, or
// a response that stopped mid-table/mid-equation. Those notes used to be saved
// as successful (and pushed to Notion), so resume then skipped them forever.
// This module is the single gate used by the pipeline, batch resume and doctor.
import { TruncatedNoteError } from "./errors.js";

export const MIN_NOTE_CHARS = 400;

// Text that proves the "note" is a site/CLI error rather than lecture content.
const ARTIFACT_PATTERNS = [
  /verify-account|verification#verify-account|account must be verified/i,
  /specified model (?:was )?not (?:recognized|found)/i,
  /resource[_ ]exhausted|quota (?:exceeded|exhausted|reached)/i,
  /\bKeyboardInterrupt\b|Traceback \(most recent call last\)/,
  /SIGINT received — closing browser/,
  /^\[[a-z0-9_-]+\]\s+(resume|mode|batch|download|archive|notes):/im,
  /editmore_vert|thumb_up\s*thumb_down/,
  /^\/home\/[^\n]*\.pdf\s*$/m,
];

const UI_ARTIFACT_START =
  /^(editmore_vert|thumb_up|error\s+Your account|model\s+\d{1,2}:\d{2}\s*(AM|PM))/i;

/**
 * Remove literal (escaped) dollars such as `\$5` without eating the closing
 * delimiter of a LaTeX expression that ends with a control space (`3\$$`).
 * A backslash only escapes a single `$`; `\$$` is `\ ` followed by `$$`.
 */
function stripLiteralDollars(line) {
  return line.replace(/\\\$(?!\$)/g, "");
}

/** Count unescaped occurrences of `token` outside fenced code blocks. */
function countOutsideCode(text, token) {
  let inFence = false;
  let n = 0;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const clean = stripLiteralDollars(line);
    let i = 0;
    while (i < clean.length) {
      if (clean.startsWith(token, i)) {
        n++;
        i += token.length;
      } else {
        i++;
      }
    }
  }
  return n;
}

/** Display-math balance, ignoring `$$` inside code fences. */
export function displayMathBalanced(text) {
  return countOutsideCode(text, "$$") % 2 === 0;
}

/** Inline-math balance after removing display-math delimiters. */
export function inlineMathBalanced(text) {
  let inFence = false;
  let inDisplay = false;
  let n = 0;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Remove escaped dollars first, then display delimiters.
    let normalized = stripLiteralDollars(line);
    const displayCount = (normalized.match(/\$\$/g) || []).length;
    normalized = normalized.replace(/\$\$/g, "");
    if (displayCount % 2) inDisplay = !inDisplay;
    // Inside $$...$$ every `$` is math content, not an inline delimiter.
    if (inDisplay || displayCount % 2) continue;
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i] === "$") n++;
    }
  }
  return n % 2 === 0;
}

function lastNonEmptyLine(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return { line: lines[i], index: i, lines };
  }
  return { line: "", index: -1, lines };
}

/**
 * Whether the line at `index` sits inside a fenced code block or a `$$...$$`
 * display-math block. Inline math/emphasis heuristics must not run there: those
 * regions legitimately contain unbalanced `$` / `*` on a single line.
 */
function insideBlock(lines, index) {
  let inFence = false;
  let inDisplay = false;
  for (let i = 0; i < index; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const delims = (stripLiteralDollars(line).match(/\$\$/g) || []).length;
    if (delims % 2) inDisplay = !inDisplay;
  }
  return inFence || inDisplay;
}

/** Count `**` pairs outside inline code on one line. */
function boldMarkers(line) {
  const noCode = line.replace(/`[^`]*`/g, "");
  return (noCode.match(/\*\*/g) || []).length;
}

/** Count unescaped single `$` on one line, ignoring `$$` delimiters. */
function inlineDollars(line) {
  const normalized = stripLiteralDollars(line).replace(/\$\$/g, "");
  return (normalized.match(/\$/g) || []).length;
}

// ------------------------------------------------------------- reasoning ----
// AI Studio renders a thinking model's trace in its own panel, and "Copy as
// markdown" sometimes copies that panel instead of the answer. The trace is
// unmistakable: first-person, present-tense planning in English ("I'm now
// focusing on...", "The user wants..."), usually under bold gerund headings.
// Real lecture notes are Bangla/English subject matter. Across this archive the
// worst genuine note scores 1%, the traces score 22-70%.
const REASONING_SENTENCE =
  /^(?:[-*+]\s+)?(?:I'm|I am|I've|I have|I will|I'll|I need|I should|I must|I can|I'd|Let me|The user|We need|We'll|We should|First,? I|Now I|Next,? I|Then I|Moving on|Okay,? I|Alright,? I|So,? I)\b/i;
const REASONING_ANY =
  /\bI(?:'m| am|'ve| have| will|'ll| need| should| must)\b/i;

/** Share of sentences that are first-person planning, as `{ sentences, reasoning, ratio }`. */
export function reasoningStats(text) {
  const sentences = String(text ?? "")
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
  let hits = 0;
  for (const s of sentences) {
    if (REASONING_SENTENCE.test(s)) hits++;
    else if (REASONING_ANY.test(s)) hits += 0.6;
  }
  return {
    sentences: sentences.length,
    reasoning: Math.round(hits * 10) / 10,
    ratio: sentences.length ? hits / sentences.length : 0,
  };
}

/**
 * True when the text is a model reasoning trace rather than an answer. The
 * thresholds sit far from real notes (which score ~0) but below the weakest
 * observed trace, so a partly-correct merge (real part + reasoning part) is
 * still caught.
 */
export function looksLikeReasoning(text) {
  const { sentences, reasoning, ratio } = reasoningStats(text);
  // Short pure traces (a small part, or a trace that ended early).
  if (reasoning >= 8 && ratio >= 0.35) return true;
  // Long texts that mix a real part with a trace part.
  return sentences >= 30 && reasoning >= 15 && ratio >= 0.08;
}


/**
 * Inspect a note and return `{ ok, issues, stats }`.
 * `issues` are `{ code, detail, severity }` with severity "error" | "warn".
 */
export function inspectNote(markdown, { minChars = MIN_NOTE_CHARS } = {}) {
  const text = String(markdown ?? "");
  const chars = text.length;
  const issues = [];
  const add = (code, detail, severity = "error") => issues.push({ code, detail, severity });

  if (!text.trim()) add("empty", "note is empty");
  else if (chars < minChars) add("too-short", `only ${chars} chars (minimum ${minChars})`);

  const firstLines = text.slice(0, 1200);
  if (UI_ARTIFACT_START.test(text.trimStart())) add("ui-artifact", "starts with a UI fragment");
  for (const re of ARTIFACT_PATTERNS) {
    if (re.test(firstLines) || re.test(text.slice(-2000))) {
      add("error-artifact", `matches ${re}`);
      break;
    }
  }

  if (!displayMathBalanced(text)) add("unbalanced-display-math", "odd number of $$ delimiters");
  if (!inlineMathBalanced(text)) add("unbalanced-inline-math", "odd number of inline $ delimiters");

  const rs = reasoningStats(text);
  if (looksLikeReasoning(text)) {
    add(
      "reasoning-trace",
      `the model's thinking, not the answer (${rs.reasoning}/${rs.sentences} planning sentences)`,
    );
  }

  const fenceCount = text.split("\n").filter((l) => /^\s*```/.test(l)).length;
  if (fenceCount % 2) add("unclosed-code-fence", "a ``` fence is never closed");

  const { line, lines, index: lastIndex } = lastNonEmptyLine(text);
  const trimmed = line.trim();
  const inBlock = insideBlock(lines, lastIndex);
  if (trimmed.startsWith("|") && !trimmed.endsWith("|")) {
    add("mid-table", "ends inside a table cell");
  }
  if (/^#{1,6}\s+\S/.test(trimmed)) {
    // A note may legitimately end on a heading only when that heading is
    // followed by content; at EOF it means the response was cut off.
    add("heading-only-tail", "ends on a heading with no content");
  }
  if (/^(\s*)([-*+]|\d+\.)\s+\*{0,2}$/.test(trimmed)) {
    add("empty-list-tail", "ends on an empty list item");
  }
  // Odd `**` count on the final line means the response stopped mid-bold.
  // Checking parity (not just "ends with **") avoids flagging a normal
  // fully-bold last bullet such as "- **মীরজাফর**".
  if (!inBlock && boldMarkers(trimmed) % 2) {
    add("mid-bold", "ends inside bold text");
  }
  // Inline code cannot span a line in Markdown, so an odd backtick count on the
  // final line is a truncation signal, not a legitimate style.
  const ticks = (trimmed.match(/(?<!`)`(?!`)/g) || []).length;
  if (!inBlock && ticks % 2) add("mid-inline-code", "ends inside inline code");
  // An odd number of single `$` delimiters on the last line means the response
  // stopped inside inline math.
  if (!inBlock && inlineDollars(trimmed) % 2) {
    add("mid-math", "ends with an unclosed inline math delimiter");
  }

  // A note that is only headings/bullets with no prose is a UI artifact.
  const proseLines = lines.filter(
    (l) => l.trim() && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|\||```|\$\$|>)/.test(l.trim()),
  );
  if (chars > minChars && proseLines.length < 3) {
    add("no-prose", "note has almost no body text", "warn");
  }

  const errors = issues.filter((i) => i.severity === "error");
  return {
    ok: errors.length === 0,
    issues,
    stats: { chars, lines: lines.length, fences: fenceCount, proseLines: proseLines.length },
  };
}

/** Throw a typed error when a note is unusable. */
export function assertValidNote(markdown, opts = {}) {
  const result = inspectNote(markdown, opts);
  if (!result.ok) {
    const summary = result.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.code)
      .join(", ");
    throw new TruncatedNoteError(`Generated note is invalid (${summary}).`, result.issues);
  }
  return result;
}

/**
 * Strip common non-note wrappers before validation/caching, without touching
 * legitimate Markdown. Used for part notes as well as the final merged note.
 *
 * AI Studio's "copy as markdown" sometimes prepends the menu chip
 * (`editmore_vert`) and appends the action bar plus playback time
 * (`thumb_upthumb_down 9m38.2s`). Those strings never occur in lecture notes,
 * so removing them is safe; it is cosmetic cleanup, not a repair.
 */
export function scrubNoteArtifacts(markdown) {
  let text = String(markdown ?? "").replace(/\r\n/g, "\n");
  // Drop a leading "Copy as markdown" menu / chip fragment.
  text = text.replace(/^\s*(editmore_vert|thumb_up\s*thumb_down)\s*/i, "");
  // Drop the trailing action bar + playback counter ("thumb_upthumb_down 9m38.2s").
  text = text.replace(/(?:thumb_up\s*thumb_down|\bthumb_up\b|\bthumb_down\b)[^\n]*$/i, "");
  // Drop a trailing playback/UI counter such as "10.1s" on its own line.
  text = text.replace(/\n\s*\d+(?:\.\d+)?s\s*$/, "\n");
  // Remove zero-width/BOM junk that sometimes prefixes the clipboard.
  text = text.replace(/^\uFEFF/, "").replace(/^\u200B+/, "");
  return text.trim() + "\n";
}

/** True when scrubbing actually changes a note (i.e. it carries UI chrome). */
export function hasUiChrome(markdown) {
  return scrubNoteArtifacts(markdown) !== String(markdown ?? "").trim() + "\n";
}

// ---------------------------------------------------------------- salvage ---
// Deterministic, media-free repair for notes that cannot be regenerated (the
// source recording is gone). It only touches damage that carries no content:
// a dangling last list item/heading, an unclosed code fence, or a stray `$$`
// the model left inside prose. It never invents text, so a note truncated
// mid-sentence stays invalid and is reported instead of "fixed".
const TAIL_CODES = new Set([
  "empty-list-tail",
  "mid-bold",
  "heading-only-tail",
  "mid-table",
  "mid-math",
  "mid-inline-code",
]);

/** Line indexes with an odd number of `$$` delimiters outside code fences. */
function oddDisplayLines(lines) {
  let inFence = false;
  const out = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const count = (stripLiteralDollars(line).match(/\$\$/g) || []).length;
    if (count % 2) out.push(i);
  });
  return out;
}

/**
 * Attempt a lossless in-place repair of common generation damage.
 * Returns `{ text, ok, issues, changes }`; `changes` explains every edit.
 */
export function salvageNote(markdown, { minChars = MIN_NOTE_CHARS } = {}) {
  let text = scrubNoteArtifacts(markdown);
  const changes = [];
  const check = () => inspectNote(text, { minChars });
  let result = check();

  for (let pass = 0; pass < 40 && !result.ok; pass++) {
    const errors = new Set(result.issues.filter((i) => i.severity === "error").map((i) => i.code));

    if (errors.has("unbalanced-display-math")) {
      const lines = text.split("\n");
      const odd = oddDisplayLines(lines);
      // An embedded `$$` on a prose/table line is a stray token, not a real
      // display block: drop it (and the empty `()` it may have left behind).
      const embedded = odd.filter((i) => {
        const t = lines[i].trim();
        if (t === "$$") return false;
        return t.replace(/\$\$/g, "").trim().length > 0;
      });
      if (embedded.length) {
        const i = embedded[0];
        const before = lines[i];
        lines[i] = lines[i]
          .replace(/\(\s*\$\$\s*\)/g, "")
          .replace(/\$\$\s*[;:,]?\s*/g, "")
          .replace(/\s{2,}/g, " ")
          .trimEnd();
        changes.push(`L${i + 1}: dropped a stray \`$$\` from prose`);
        text = lines.join("\n");
      } else if (odd.length) {
        // Only standalone delimiters are left: a display block was opened and
        // never closed before EOF. Cut from that opener.
        const cut = odd[odd.length - 1];
        const kept = lines.slice(0, cut).join("\n").trimEnd();
        if (kept.length < minChars) break;
        text = kept + "\n";
        changes.push(`dropped an unclosed display block from L${cut + 1}`);
      } else {
        break;
      }
      result = check();
      continue;
    }

    if (errors.has("unclosed-code-fence")) {
      // The fence's body is real content; closing it at EOF renders what exists.
      text = text.trimEnd() + "\n```\n";
      changes.push("closed a code fence left open at EOF");
      result = check();
      continue;
    }

    if ([...errors].some((c) => TAIL_CODES.has(c))) {
      const lines = text.replace(/\s+$/, "").split("\n");
      let i = lines.length - 1;
      while (i >= 0 && !lines[i].trim()) i--;
      if (i < 0) break;
      lines.splice(i, 1);
      const next = lines.join("\n").trimEnd() + "\n";
      if (next.length < minChars) break;
      text = next;
      changes.push(`dropped a dangling tail line (L${i + 1})`);
      result = check();
      continue;
    }

    break;
  }

  return { text, ok: result.ok, issues: result.issues, changes };
}
