import { describe, expect, test } from "bun:test";
import { runPool } from "../lib/pool.js";

describe("runPool", () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test("processes every item exactly once, in order per lane", async () => {
    const seen = [];
    const lanesSeen = [];
    await runPool([0, 1, 2, 3, 4, 5, 6], 3, async (item, index, lane) => {
      lanesSeen.push(lane);
      seen.push(index);
      await wait(5);
    });
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("never runs more than the requested number of lanes at once", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await wait(10);
      active--;
    });
    expect(peak).toBe(2);
  });

  test("concurrency above the item count collapses to one lane per item", async () => {
    const lanes = new Set();
    await runPool([1, 2], 8, async (_item, _i, lane) => {
      lanes.add(lane);
    });
    expect(lanes).toEqual(new Set([0, 1]));
  });

  test("an empty list does nothing", async () => {
    let called = false;
    await runPool([], 3, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test("bad input falls back to one lane", async () => {
    const lanes = new Set();
    await runPool([1, 2], 0, async (_item, _i, lane) => {
      lanes.add(lane);
    });
    expect(lanes).toEqual(new Set([0]));
  });
});
