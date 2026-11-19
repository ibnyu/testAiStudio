// End-to-end check of the Drive-link attach path against a mock of the AI
// Studio prompt box. Skipped by default (it launches a real Chromium):
//
//   ZS_E2E=1 bun test tests/attach.e2e.test.js
//
// It exists because the attach step is the one place that touches the shared OS
// clipboard, and a regression there silently feeds the wrong file to a model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { attachDriveLink } from "../lib/aistudio.js";

const LINK = "https://drive.google.com/open?id=1k_yMeXo3G3eAwhauwlyFItCu9bcwUvIf";

const PAGE = `<!doctype html>
<textarea aria-label="Enter a prompt"></textarea>
<script>
  window.__seen = [];
  // Records what the paste actually carried, before the guard can stop it.
  window.addEventListener("paste", (e) => {
    const dt = e.clipboardData;
    window.__seen.push({ types: dt ? [...dt.types] : [], text: dt ? dt.getData("text/plain") : "" });
  }, true);
  // Mimics AI Studio: a Drive link becomes a file chip, other text lands in the box.
  window.__applied = [];
  window.addEventListener("paste", (e) => {
    const t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    window.__applied.push(t);
    if (/drive\\.google\\.com/.test(t)) {
      const m = document.createElement("ms-prompt-media");
      m.textContent = "part-01.mp3 1,234 tokens";
      document.body.appendChild(m);
    } else if (t) {
      document.querySelector("textarea").value += t;
    }
  });
</script>`;

const e2e = process.env.ZS_E2E ? describe : describe.skip;

/** The stealth Chromium this repo already uses (playwright's own build is not installed). */
function chromeBinary() {
  if (process.env.CLOAKBROWSER_BINARY_PATH) return process.env.CLOAKBROWSER_BINARY_PATH;
  const root = join(homedir(), ".cloakbrowser");
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, "chrome");
    if (existsSync(p)) return p;
  }
  return undefined;
}

let server;
let browser;
let context;

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
  browser = await chromium.launch({ headless: true, executablePath: chromeBinary(), args: ["--no-sandbox"] });
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
});

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  server?.stop(true);
});

async function freshPage() {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  return page;
}

const chips = (page) => page.evaluate(() => document.querySelectorAll("ms-prompt-media").length);
const box = (page) => page.evaluate(() => document.querySelector("textarea").value);

e2e("attachDriveLink against a mock AI Studio", () => {
  test("attaches the link and keeps the prompt box empty", async () => {
    const page = await freshPage();
    const method = await attachDriveLink(page, LINK);
    expect(["clipboard-paste", "synthetic-paste"]).toContain(method);
    expect(await chips(page)).toBe(1);
    expect(await box(page)).toBe("");
    await page.close();
  }, 60000);

  test("a foreign clipboard is blocked instead of being attached", async () => {
    const page = await freshPage();
    // Simulate the race the user hit: writeText claims success (readback says
    // the link is there) but the clipboard actually holds something else.
    await page.evaluate(() => {
      const real = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = () => real("USER COPIED THIS");
      navigator.clipboard.readText = async () => window.__fakeReadback;
    });
    // readback must equal the link, otherwise the paste is skipped outright
    await page.evaluate((l) => {
      window.__fakeReadback = l;
    }, LINK);

    const method = await attachDriveLink(page, LINK);
    expect(method).toBe("synthetic-paste");
    expect(await chips(page)).toBe(1);
    // The user's text must never reach the prompt (or the model).
    expect(await box(page)).toBe("");
    // The guard cancelled the real Ctrl+V before the site's own handler ran:
    // only the DOM paste (carrying the link) reached it.
    const applied = await page.evaluate(() => window.__applied);
    expect(applied.some((t) => t.includes("USER COPIED THIS"))).toBe(false);
    expect(applied.some((t) => t.includes("1k_yMeXo3G3eAwhauwlyFItCu9bcwUvIf"))).toBe(true);
    await page.close();
  }, 60000);

  test("a denied clipboard write still attaches via the DOM paste", async () => {
    const page = await freshPage();
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("denied");
      };
    });
    const method = await attachDriveLink(page, LINK);
    expect(method).toBe("synthetic-paste");
    expect(await chips(page)).toBe(1);
    await page.close();
  }, 60000);

  test("an image chip is rejected rather than used", async () => {
    const page = await freshPage();
    // Mock a paste path that attaches an image instead of the Drive document.
    await page.evaluate(() => {
      window.addEventListener(
        "paste",
        (e) => {
          e.stopImmediatePropagation();
          const img = document.createElement("img");
          img.src = "data:image/png;base64,iVBORw0KGgo=";
          const chip = document.createElement("ms-prompt-media");
          chip.appendChild(img);
          document.body.appendChild(chip);
        },
        true,
      );
    });
    await expect(attachDriveLink(page, LINK, { expectedName: "part-01.mp3" })).rejects.toThrow(
      /wrong item/,
    );
    await page.close();
  }, 60000);
});
