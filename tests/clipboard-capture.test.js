import { describe, expect, test } from "bun:test";
import {
  CAPTURE_KEY,
  clipboardCaptureScript,
  readCapturedClipboard,
  EMPTY_CAPTURE,
} from "../lib/clipboard-capture.js";

describe("clipboard capture", () => {
  test("patches writeText and listens for copy events", () => {
    const script = clipboardCaptureScript();
    expect(script).toContain(CAPTURE_KEY);
    expect(script).toContain("writeText");
    expect(script).toContain('"copy"');
    expect(script).toContain("getData");
    expect(script).toContain("execCommand");
    expect(script).toContain("activeElement");
  });

  test("readCapturedClipboard tolerates a page without the script", async () => {
    const page = {
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      },
    };
    expect(await readCapturedClipboard(page)).toEqual(EMPTY_CAPTURE);
  });

  test("readCapturedClipboard returns the captured payload", async () => {
    const page = {
      evaluate: async () => ({ text: "# note", seq: 2, at: 5, source: "writeText" }),
    };
    expect(await readCapturedClipboard(page)).toEqual({
      text: "# note",
      seq: 2,
      at: 5,
      source: "writeText",
    });
  });
});
