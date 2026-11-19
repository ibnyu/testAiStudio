import { describe, expect, test } from "bun:test";
import { driveFileId, withClipboard } from "../lib/aistudio.js";

describe("attachDriveLink clipboard safety", () => {
  // The paste guard compares the clipboard contents with the link it wrote; a
  // parsing slip here would let a foreign paste through, so pin the formats.
  test("extracts the id from an open?id= link", () => {
    expect(driveFileId("https://drive.google.com/open?id=1k_yMeXo3G3eAwhauwlyFItCu9bcwUvIf")).toBe(
      "1k_yMeXo3G3eAwhauwlyFItCu9bcwUvIf",
    );
  });

  test("extracts the id from /file/d/ and /d/ links", () => {
    expect(driveFileId("https://drive.google.com/file/d/abc-123_X/view?usp=sharing")).toBe("abc-123_X");
    expect(driveFileId("https://drive.google.com/d/abc-123_X")).toBe("abc-123_X");
  });

  test("returns an empty string for links without an id", () => {
    expect(driveFileId("")).toBe("");
    expect(driveFileId("https://drive.google.com/drive/folders/xyz")).toBe("");
    expect(driveFileId(null)).toBe("");
  });
});


describe("withClipboard serialization", () => {
  // Every tab shares the OS clipboard. Two lanes writing a link and pressing
  // Ctrl+V concurrently would paste the wrong text into the wrong tab.
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("a second clipboard job waits for the first to finish", async () => {
    const order = [];
    let release;
    const first = withClipboard(async () => {
      order.push("first-start");
      await new Promise((r) => (release = r));
      order.push("first-end");
      return "first";
    });
    const second = withClipboard(async () => {
      order.push("second-start");
      return "second";
    });

    await tick();
    expect(order).toEqual(["first-start"]); // second has not started
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("a failed clipboard job does not wedge the queue", async () => {
    await expect(
      withClipboard(async () => {
        throw new Error("clipboard denied");
      }),
    ).rejects.toThrow("clipboard denied");
    expect(await withClipboard(async () => "recovered")).toBe("recovered");
  });
});
