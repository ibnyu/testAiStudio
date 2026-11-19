import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDownloaded,
  absolutizeManifest,
  markDownloadStarted,
  markDownloadFinished,
  downloadArtifacts,
} from "../lib/batchdl.js";

let dirs = [];
function makeDir() {
  const d = mkdtempSync(join(tmpdir(), "zaknotes-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("findDownloaded", () => {
  test("accepts a finished file", () => {
    const dir = makeDir();
    const f = join(dir, "Lecture 01.mp3");
    writeFileSync(f, "audio");
    expect(findDownloaded(dir, "Lecture 01")).toBe(f);
  });

  test("rejects a zero-byte file", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "Lecture 01.mp3"), "");
    expect(findDownloaded(dir, "Lecture 01")).toBeNull();
  });

  test("rejects a .part sibling", () => {
    const dir = makeDir();
    const f = join(dir, "Lecture 01.mp3");
    writeFileSync(f, "audio");
    writeFileSync(f + ".part", "partial");
    expect(findDownloaded(dir, "Lecture 01")).toBeNull();
  });

  test("rejects when an in-progress marker survived Ctrl+C", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "Lecture 01.mp3"), "audio");
    markDownloadStarted({ dir, name: "Lecture 01" });
    expect(findDownloaded(dir, "Lecture 01")).toBeNull();
  });

  test("completion marker clears the in-progress state", () => {
    const dir = makeDir();
    const f = join(dir, "Lecture 01.mp3");
    writeFileSync(f, "audio");
    markDownloadStarted({ dir, name: "Lecture 01" });
    markDownloadFinished({ dir, name: "Lecture 01" }, [f]);
    expect(findDownloaded(dir, "Lecture 01")).toBe(f);
  });

  test("rejects an interrupted webm->mp3 conversion", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "Lecture 01.webm"), Buffer.alloc(2_000_000, 1));
    writeFileSync(join(dir, "Lecture 01.mp3"), Buffer.alloc(100_000, 1));
    expect(findDownloaded(dir, "Lecture 01")).toBeNull();
  });

  test("a completion marker overrides the conversion heuristic", () => {
    const dir = makeDir();
    const f = join(dir, "Lecture 01.mp3");
    writeFileSync(join(dir, "Lecture 01.webm"), Buffer.alloc(2_000_000, 1));
    writeFileSync(f, Buffer.alloc(100_000, 1));
    writeFileSync(f + ".complete", "ok");
    expect(findDownloaded(dir, "Lecture 01")).toBe(f);
  });

  test("downloadArtifacts includes media and sidecars", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "Lecture 01.mp3"), "a");
    writeFileSync(join(dir, "Lecture 01.mp3.part"), "b");
    writeFileSync(join(dir, "Lecture 02.mp3"), "c");
    const arts = downloadArtifacts(dir, "Lecture 01").map((p) => p.split("/").pop()).sort();
    expect(arts).toEqual(["Lecture 01.mp3", "Lecture 01.mp3.part"]);
  });
});

describe("absolutizeManifest", () => {
  test("resolves segment lines and URI attributes", () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      "#EXTINF:10,",
      "seg-1.ts",
      "#EXT-X-MAP:URI=\"/init.mp4\"",
    ].join("\n");
    const out = absolutizeManifest(body, "https://cdn.example.com/path/master.m3u8?token=x");
    expect(out).toContain('URI="https://cdn.example.com/path/key.bin"');
    expect(out).toContain("https://cdn.example.com/path/seg-1.ts");
    expect(out).toContain('URI="https://cdn.example.com/init.mp4"');
  });
});
