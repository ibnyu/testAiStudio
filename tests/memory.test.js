import { describe, expect, test } from "bun:test";
import { ensureMemoryHeadroom, memorySnapshotMB } from "../lib/memory.js";

describe("memory headroom", () => {
  test("snapshot reports plausible MiB values", () => {
    const snap = memorySnapshotMB();
    if (!snap) return; // non-Linux: guard is a no-op
    expect(typeof snap.availableMB).toBe("number");
    expect(snap.availableMB).toBeGreaterThan(0);
    expect(snap.availableMB).toBeLessThanOrEqual(snap.totalMB);
  });

  test("returns immediately when the thresholds are satisfied", async () => {
    const snap = await ensureMemoryHeadroom({ minFreeMB: 0, minSwapMB: 0, reap: false });
    expect(snap === null || typeof snap.availableMB === "number").toBe(true);
  });

  test("fails fast with a retryable memory error when pressure is impossible", async () => {
    if (!memorySnapshotMB()) return; // non-Linux
    const err = await ensureMemoryHeadroom({
      minFreeMB: Number.MAX_SAFE_INTEGER,
      minSwapMB: Number.MAX_SAFE_INTEGER,
      waitMs: 0,
      reap: false,
      label: "test browser",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("memory");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Not enough free memory");
  });
});
