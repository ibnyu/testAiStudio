// Sanitize LaTeX so it renders in KaTeX (Notion equations, notebooks).
//
// The model sometimes drops native-script prose (Bengali etc.) inside math, e.g.
//   $$V_H = B \cdot v \cdot (\text{তড়িৎ প্রবাহ ...})$$
// KaTeX cannot typeset those scripts in text mode and throws a parse error.
// We drop such \text{...}/\mathrm{...} (and a leading \cdot/\times/+- if it would
// dangle) and tidy the leftover artifacts inside math. Symbolic math is
// untouched; only constructs containing a non-Latin script are rewritten.

// Scripts/fonts KaTeX's math text mode cannot render (verifiable failures).
const NON_LATIN_TEXT = new RegExp(
  "[" +
    "\\u0590-\\u05FF\\u0600-\\u06FF" + // Hebrew, Arabic
    "\\u0900-\\u097F\\u0980-\\u09FF\\u0A00-\\u0A7F\\u0A80-\\u0AFF" + // Indic
    "\\u0B00-\\u0B7F\\u0B80-\\u0BFF\\u0C00-\\u0C7F\\u0C80-\\u0CFF" +
    "\\u0D00-\\u0D7F\\u0D80-\\u0DFF" +
    "\\u0E00-\\u0E7F\\u0E80-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF" + // SEA
    "\\u0F00-\\u0FFF\\u3000-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF" + // CJK + kana
    "\\uAC00-\\uD7AF" + // Hangul
    "\\u{1F000}-\\u{1FAFF}" + // emoji
    "]",
  "u",
);

// \text{...}/\mathrm{...}/... optionally preceded by a dangling operator.
const TEXT_CMD =
  /(\s*(?:\\(?:cdot|times)|\+|-)?\s*)\\(text|mathrm|mathbf|mathit|mathsf|mathtt|operatorname|mbox)\{([^{}]*)\}/g;

export function sanitizeMath(markdown) {
  if (!markdown) return markdown;
  let changed = false;
  let out = markdown.replace(TEXT_CMD, (m, _pre, _cmd, arg) => {
    if (NON_LATIN_TEXT.test(arg)) {
      changed = true;
      return "";
    }
    return m;
  });
  if (!changed) return out;

  // Tidy artifacts left inside math after dropping a \text{...}.
  out = out.replace(/(\${1,2})([\s\S]*?)\1/g, (m, d, body) => {
    let b = body
      .replace(/\(\s*\)/g, "")
      .replace(/\\left\(\s*\\right\)/g, "")
      .replace(/\\(?:cdot|times)\s*(?=[)}\]])/g, "")
      .replace(/\\(?:cdot|times)\s*$/g, "");
    return d + b.replace(/[ \t]{2,}/g, " ").trim() + d;
  });
  return out;
}
