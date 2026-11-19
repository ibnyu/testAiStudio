import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSlideParts } from "../lib/slides.js";

describe("planSlideParts", () => {
  test("returns nothing for a missing file", () => {
    expect(planSlideParts("/does/not/exist.pdf", { audioParts: 2 })).toEqual([]);
  });

  test("keeps one PDF for a single audio part", () => {
    const dir = mkdtempSync(join(tmpdir(), "zaknotes-slides-"));
    try {
      const file = join(dir, "slides.pdf");
      writeFileSync(file, "%PDF-1.4\n");
      const parts = planSlideParts(file, { audioParts: 1 });
      expect(parts).toHaveLength(1);
      expect(parts[0].path).toBe(file);
      expect(parts[0].temp).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not split an unreadable/small PDF for multiple parts", () => {
    const dir = mkdtempSync(join(tmpdir(), "zaknotes-slides-"));
    try {
      const file = join(dir, "slides.pdf");
      writeFileSync(file, "%PDF-1.4\n");
      const parts = planSlideParts(file, { audioParts: 3 });
      expect(parts).toHaveLength(1);
      expect(parts[0].path).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
