import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockOwner } from "../lib/lock.js";

const dir = mkdtempSync(join(tmpdir(), "zs-lock-"));
const lock = (name, content) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe("lockOwner", () => {
  test("is null when there is no lock file", () => {
    expect(lockOwner(join(dir, "absent.lock"))).toBeNull();
  });

  test("reports the pid of a live holder", () => {
    expect(lockOwner(lock("live.lock", String(process.pid)))).toBe(process.pid);
  });

  test("treats a dead pid as free", () => {
    // Far above any real pid; kill(pid, 0) fails with ESRCH.
    expect(lockOwner(lock("dead.lock", "2147483646"))).toBeNull();
  });

  test("treats garbage as free instead of throwing", () => {
    expect(lockOwner(lock("junk.lock", "not-a-pid"))).toBeNull();
  });
});
