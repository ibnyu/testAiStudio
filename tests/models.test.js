import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL,
  LATEST_FLASH,
  FLASH_ALIAS,
  newChatUrl,
  slugFromText,
  pickLatestFlash,
  modelChain,
  concreteOf,
  version,
} from "../lib/models.js";

describe("model defaults", () => {
  test("gemini-4-hydrogen is the default", () => {
    expect(DEFAULT_MODEL).toBe("gemini-4-hydrogen");
  });

  test("latest-flash omits the query and concrete slugs pin it", () => {
    expect(newChatUrl(LATEST_FLASH)).toBe("https://aistudio.google.com/prompts/new_chat");
    expect(newChatUrl("gemini-4-hydrogen")).toBe(
      "https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen",
    );
  });

  test("slug parser keeps the full dotted/hyphenated slug", () => {
    expect(slugFromText("Points to gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(slugFromText("gemini-4-hydrogen")).toBe("gemini-4-hydrogen");
    expect(version("gemini-3.8-flash")).toEqual([3, 8]);
  });
});

describe("pickLatestFlash", () => {
  const models = [
    { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { slug: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { slug: "gemini-3.8-flash-lite", name: "Gemini 3.8 Flash Lite" },
    { slug: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { slug: FLASH_ALIAS, name: "Gemini Flash Latest", aliasOf: "gemini-3.8-flash" },
  ];

  test("resolves the alias and ignores lite variants", () => {
    const p = pickLatestFlash(models);
    expect(p.slug).toBe("gemini-3.8-flash");
  });

  test("prefers the newest concrete version when no alias exists", () => {
    const p = pickLatestFlash(models.filter((m) => m.slug !== FLASH_ALIAS));
    expect(p.slug).toBe("gemini-3.8-flash");
  });

  test("returns null when no plain flash exists", () => {
    expect(pickLatestFlash([{ slug: "gemini-4-hydrogen" }])).toBeNull();
  });

  test("concreteOf follows an alias target", () => {
    expect(concreteOf({ slug: FLASH_ALIAS, aliasOf: "gemini-3.8-flash" })).toBe("gemini-3.8-flash");
  });
});

describe("modelChain", () => {
  test("configured model leads, fallbacks follow, duplicates removed", () => {
    const chain = modelChain("gemini-4-hydrogen", ["gemini-3.8-flash", "gemini-4-hydrogen"]);
    expect(chain[0]).toBe("gemini-4-hydrogen");
    expect(chain[1]).toBe("gemini-3.8-flash");
    expect(new Set(chain).size).toBe(chain.length);
  });

  test("always includes the default model", () => {
    expect(modelChain("gemini-flash-latest", [])).toContain(DEFAULT_MODEL);
  });
});
