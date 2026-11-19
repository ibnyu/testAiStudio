import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planChunks,
  planKey,
  PartCache,
  DEFAULT_MAX_MINUTES,
  DEFAULT_CEILING_MINUTES,
} from "../lib/chunk.js";

const minutes = (n) => n * 60;
const PART = `${"বিষয়টির ব্যাখ্যা ও উদাহরণ এখানে বিস্তারিতভাবে দেওয়া হয়েছে। ".repeat(6)}\n`;
const freshDir = () => mkdtempSync(join(tmpdir(), "zaknotes-parts-"));

describe("planChunks", () => {
  test("unknown duration stays one part", () => {
    expect(planChunks(null)).toEqual([{ index: 1, count: 1, start: 0, durationSec: null }]);
  });

  test("defaults are 120 min with a 150 min ceiling", () => {
    expect(DEFAULT_MAX_MINUTES).toBe(120);
    expect(DEFAULT_CEILING_MINUTES).toBe(150);
  });

  test("short and exactly-max lectures stay one part", () => {
    expect(planChunks(minutes(90))).toHaveLength(1);
    expect(planChunks(minutes(120))).toHaveLength(1);
  });

  test("equal-sized parts: 210 min -> two 105 min parts", () => {
    const p = planChunks(minutes(210));
    expect(p).toHaveLength(2);
    expect(p[0].durationSec).toBeCloseTo(minutes(105), 6);
    expect(p[1].durationSec).toBeCloseTo(minutes(105), 6);
    expect(p[1].start + p[1].durationSec).toBeCloseTo(minutes(210), 6);
  });

  test("300 min -> three 100 min parts", () => {
    const p = planChunks(minutes(300));
    expect(p).toHaveLength(3);
    for (const c of p) expect(c.durationSec).toBeCloseTo(minutes(100), 6);
  });

  test("maxMinutes above the ceiling is clamped", () => {
    const p = planChunks(minutes(300), { maxMinutes: 400, ceilingMinutes: 150 });
    expect(p).toHaveLength(2);
  });

  test("a 90 minute conservative setting splits 120 min into two", () => {
    const p = planChunks(minutes(120), { maxMinutes: 90 });
    expect(p).toHaveLength(2);
  });

  test("planKey changes with duration and chunk size", () => {
    expect(planKey(minutes(210), { maxMinutes: 120 })).not.toBe(planKey(minutes(240), { maxMinutes: 120 }));
    expect(planKey(minutes(210), { maxMinutes: 120 })).not.toBe(planKey(minutes(210), { maxMinutes: 90 }));
  });
});

describe("PartCache", () => {
  const make = (dir, ext = {}) =>
    new PartCache({ notesDir: dir, noteBase: "Lecture", durationSec: minutes(210), chunking: { maxMinutes: 120 }, ...ext });

  test("caches successful parts and keeps a failed part as failed", () => {
    const dir = freshDir();
    const c = make(dir);
    c.manifest.count = 2;
    c.save();
    c.write(1, PART, { model: "m" });
    c.markFailed(2, "quota exhausted");

    const again = make(dir);
    expect(again.manifest.count).toBe(2);
    expect(again.read(1)).toBe(PART);
    expect(again.read(2)).toBeNull();
    expect(again.manifest.parts[2].status).toBe("failed");
    expect(again.manifest.parts[1].status).toBe("ok");
  });

  test("a part file is on disk as soon as write returns", () => {
    const dir = freshDir();
    const c = make(dir);
    c.manifest.count = 2;
    c.write(1, PART);
    expect(existsSync(c.partPath(1))).toBe(true);
  });

  test("a corrupt manifest clears stale parts instead of merging them", () => {
    const dir = freshDir();
    const first = make(dir);
    first.manifest.count = 2;
    first.write(1, PART);
    writeFileSync(first.manifestPath, "{not json");

    const fresh = make(dir);
    expect(existsSync(fresh.partPath(1))).toBe(false);
    expect(fresh.read(1)).toBeNull();
    expect(fresh.manifest.parts).toEqual({});
  });

  test("a changed duration invalidates the cached parts", () => {
    const dir = freshDir();
    const first = make(dir);
    first.manifest.count = 2;
    first.write(1, PART);

    const longer = new PartCache({
      notesDir: dir,
      noteBase: "Lecture",
      durationSec: minutes(300),
      chunking: { maxMinutes: 120 },
    });
    expect(longer.read(1)).toBeNull();
    expect(longer.manifest.parts).toEqual({});
  });
});
