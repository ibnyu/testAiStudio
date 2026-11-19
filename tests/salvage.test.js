import { describe, expect, test } from "bun:test";
import { inspectNote, salvageNote, MIN_NOTE_CHARS } from "../lib/validate.js";

const body = `# অধ্যায়

## বিষয়

এই অংশে বিষয়টির বিস্তারিত ব্যাখ্যা আছে, যাতে নোটটি যথেষ্ট বড় হয় এবং
স্বাভাবিক অনুচ্ছেদ হিসেবে গণ্য হয়। একটি সূত্র $$a^2 + b^2 = c^2$$ এবং
ইনলাইন গণিত $x = 1$ আছে।

- প্রথম পয়েন্ট
- দ্বিতীয় পয়েন্ট
- তৃতীয় পয়েন্ট

${"আরেকটি অনুচ্ছেদ যেখানে যুক্তি ও উদাহরণ দেওয়া হয়েছে। ".repeat(6)}
`;

describe("salvageNote", () => {
  test("leaves a valid note untouched", () => {
    const r = salvageNote(body);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(body.trimEnd() + "\n");
    expect(r.changes).toHaveLength(0);
  });

  test("drops a dangling empty list item at EOF", () => {
    const raw = `${body}\n3. **`;
    expect(inspectNote(raw).ok).toBe(false);
    const r = salvageNote(raw);
    expect(r.ok).toBe(true);
    expect(r.text.endsWith("3. **")).toBe(false);
    expect(r.changes.length).toBeGreaterThan(0);
  });

  test("drops a heading left with no content at EOF", () => {
    const raw = `${body}\n### সারাংশ\n1. **`;
    const r = salvageNote(raw);
    expect(r.ok).toBe(true);
    expect(r.text.includes("### সারাংশ")).toBe(false);
  });

  test("removes a stray display delimiter embedded in a table row", () => {
    const raw = body.replace(
      "- প্রথম পয়েন্ট",
      () => "| বিকারক | লুকাস বিকারক ($$) যোগ করলে |\n|---|---|\n| ৩° | সাথে সাথে |",
    );
    expect(inspectNote(raw).ok).toBe(false);
    const r = salvageNote(raw);
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("($$)");
  });

  test("removes a stray leading display delimiter on a prose line", () => {
    const raw = body.replace("- প্রথম পয়েন্ট", () => "$$; বিক্রিয়াটি কেমন?\n\n- প্রথম পয়েন্ট");
    const r = salvageNote(raw);
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("$$;");
    expect(r.text).toContain("বিক্রিয়াটি কেমন?");
  });

  test("closes a code fence left open at EOF", () => {
    const raw = `${body}\n\`\`\`mermaid\ngraph TD\n  A --> B`;
    expect(inspectNote(raw).issues.some((i) => i.code === "unclosed-code-fence")).toBe(true);
    const r = salvageNote(raw);
    expect(r.ok).toBe(true);
    expect(r.text.trimEnd().endsWith("```")).toBe(true);
  });

  test("never rewrites a note with no structural damage", () => {
    const raw = `# অধ্যায়\n\n${"এই বাক্যটি যুক্তি ও উদাহরণ দিয়ে চলতে থাকে। ".repeat(12)}\n\nএকটি অসম্পূর্ণ বাক্য`;
    const r = salvageNote(raw);
    expect(r.changes).toHaveLength(0);
    expect(r.text).toBe(raw.trimEnd() + "\n");
  });

  test("refuses to trim below the minimum size", () => {
    // Alternating tail damage would otherwise eat the whole note.
    const raw = `${"a".repeat(MIN_NOTE_CHARS)}\n\n1. **`;
    const r = salvageNote(raw);
    expect(r.text.length).toBeGreaterThanOrEqual(MIN_NOTE_CHARS);
  });
});
