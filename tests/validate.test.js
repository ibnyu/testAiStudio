import { describe, expect, test } from "bun:test";
import {
  inspectNote,
  scrubNoteArtifacts,
  displayMathBalanced,
  inlineMathBalanced,
  looksLikeReasoning,
  reasoningStats,
  MIN_NOTE_CHARS,
} from "../lib/validate.js";

const good = `# Lecture

## Topic

This is a substantial explanation of the topic with enough prose to be useful.
It includes a formula $$a^2 + b^2 = c^2$$ and inline math $x = 1$.

- point one
- point two
- point three

Another paragraph with real content, reasoning, and an example.
${"The lecture continues with a worked derivation and a clear explanation. ".repeat(8)}
`;

describe("inspectNote", () => {
  test("accepts a normal note", () => {
    const r = inspectNote(good);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  test("rejects tiny/empty notes", () => {
    expect(inspectNote("").ok).toBe(false);
    expect(inspectNote("short").ok).toBe(false);
    expect(inspectNote("x".repeat(MIN_NOTE_CHARS + 10)).ok).toBe(true); // long enough; no structural error
  });

  test("rejects unbalanced display math", () => {
    const text = good + "\n$$\\frac{a}{b}\n";
    const r = inspectNote(text);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "unbalanced-display-math")).toBe(true);
  });

  test("rejects a note ending mid-table-cell", () => {
    const text = good + "\n| a | b |\n|---|---|\n| 1 | 2 |\n| `x` | super";
    const r = inspectNote(text);
    expect(r.issues.some((i) => i.code === "mid-table")).toBe(true);
  });

  test("rejects a heading-only tail", () => {
    const text = good + "\n### প্রশ্ন ১\n";
    expect(inspectNote(text).issues.some((i) => i.code === "heading-only-tail")).toBe(true);
  });

  test("rejects account-verification pages", () => {
    const text = "error Your account must be verified before it can continue using this service. https://aistudio.google.com/verify-account";
    const r = inspectNote(text);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "error-artifact")).toBe(true);
  });

  test("rejects terminal logs", () => {
    const text = good.slice(0, 500) + "\n[browser] SIGINT received — closing browser(s)...\nKeyboardInterrupt:";
    expect(inspectNote(text).issues.some((i) => i.code === "error-artifact")).toBe(true);
  });

  test("rejects an unclosed code fence", () => {
    const text = good + "\n```python\nprint('hi')\n";
    expect(inspectNote(text).issues.some((i) => i.code === "unclosed-code-fence")).toBe(true);
  });

  test("rejects an empty list tail", () => {
    const text = good + "\n1. **";
    expect(inspectNote(text).issues.some((i) => i.code === "empty-list-tail" || i.code === "mid-bold")).toBe(true);
  });

  test("accepts a final bullet that ends with complete bold text", () => {
    const text = good + "\n- **[IMPORTANT]** চুক্তিতে স্বাক্ষর করেন: **মীরজাফর**\n";
    expect(inspectNote(text).ok).toBe(true);
  });

  test("accepts a final line ending with balanced inline math", () => {
    const text = good + "\nসূত্র: $c^2 = a^2 + b^2$\n";
    expect(inspectNote(text).ok).toBe(true);
  });

  test("rejects a final line ending inside bold or inline math", () => {
    const bold = good + "\n- **মীরজাফর ও ক্লাইভের";
    expect(inspectNote(bold).issues.some((i) => i.code === "mid-bold")).toBe(true);
    const math = good + "\n3. **$\\mathrm{H_3PO_3}$ (দুটি $\\mathrm{O-H}$ বন্ধন $";
    expect(inspectNote(math).issues.some((i) => i.code === "mid-math")).toBe(true);
  });

  test("ignores dollar parity inside a display-math block", () => {
    const text = good + "\n$$\n\\text{cost } $5 \\text{ per unit}\n$$\n";
    expect(inspectNote(text).ok).toBe(true);
  });
});

describe("math balance helpers", () => {
  test("ignores escaped dollars and code fences", () => {
    const text = "Price is \\$5 and `$not math$`.\n$$\na+b\n$$\n";
    expect(displayMathBalanced(text)).toBe(true);
    expect(inlineMathBalanced(text)).toBe(true);
  });

  test("a display expression ending in a control space still closes", () => {
    const text = "$$d = \\frac{8-6}{8+6} \\cdot 21 = 3\\$$\n\ninline $x$ text\n";
    expect(displayMathBalanced(text)).toBe(true);
  });
});

describe("scrubNoteArtifacts", () => {
  test("removes leading UI fragments and trailing timers", () => {
    const text = "editmore_vert\n# Real note\n\nbody\n10.1s";
    const out = scrubNoteArtifacts(text);
    expect(out).not.toContain("editmore_vert");
    expect(out).not.toMatch(/10\.1s\s*$/);
    expect(out).toContain("# Real note");
  });
});

describe("reasoning traces", () => {
  // AI Studio renders a thinking model's trace in its own panel, and the
  // "Copy as markdown" menu of that panel yields the trace instead of the
  // answer. Such a note is prose and passes every other check, so it needs its
  // own detector (this exact text was saved as "ICT Rakib P1 Ch2 02").
  const trace = `
**Analyzing the Input Data**

I'm carefully reviewing the provided materials. I need to understand the transcript with its English technical terms, and then reconcile it with the slide PDF.

**Reviewing the System Rules**

I'm focused now on the system rules. I'm making sure I completely understand the formatting and language constraints, especially for the Bangla context and the specific allowed markdown elements.

**Refining the Extraction Process**

I'm now diving deep into refining my extraction process, specifically focusing on how to handle the detailed content rules and teacher instructions.

**Implementing the Structure**

I'm now integrating the output blocks. I am focusing on accurately translating and re-creating these visual elements within the markdown structure.

**Clarifying the Question Structure**

I'm now clarifying the structure of the questions. I am working to ensure compliance with the formatting guidelines.

**Structuring the Answers**

I'm now carefully structuring the answer sections, considering how best to present this information. I am making sure that the existing instructions guide me correctly.

**Checking the Language**

I'm reviewing the language choice for each heading. I will ensure the Bangla labels are kept exactly as the teacher wrote them.

**Final Pass**

I'm now doing a final pass over the material to make sure nothing is missed before I start writing the notes.
`;

  test("a thinking trace is rejected", () => {
    const r = inspectNote(trace, { minChars: 100 });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("reasoning-trace");
  });

  test("looksLikeReasoning is not fooled by a normal Bangla note", () => {
    const note = `# ১. সংখ্যা পদ্ধতি

এই অধ্যায় থেকে পরীক্ষায় সাধারণত **২টি সৃজনশীল প্রশ্ন** আসে। আমি এখানে প্রতিটি ধাপ ব্যাখ্যা করব।

**গুরুত্বপূর্ণ টপিক:**
1. সংখ্যা পদ্ধতির পারস্পরিক রূপান্তর।
2. **২-এর পরিপূরক** বা যোগের সাহায্যে বিয়োগ। **[EXAM FOCUS]**

এখানে আমি দেখাচ্ছি কীভাবে বাইনারি যোগ করা হয়: $1010 + 0110 = 10000$।

- প্রথমে ডান দিক থেকে যোগ শুরু করি।
- ক্যারি পরের ঘরে নিয়ে যাই।
`;
    expect(looksLikeReasoning(note)).toBe(false);
    expect(inspectNote(note, { minChars: 100 }).ok).toBe(true);
  });

  test("stats separate planning sentences from subject matter", () => {
    const s = reasoningStats(trace);
    expect(s.sentences).toBeGreaterThan(5);
    expect(s.ratio).toBeGreaterThan(0.5);
    expect(reasoningStats("# শিরোনাম\n\nসাধারণ আলোচনা।").ratio).toBe(0);
  });
});
