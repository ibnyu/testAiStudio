// End-to-end check of the "Copy as markdown" path when the turn also carries a
// thinking trace. Skipped by default (it launches a real Chromium):
//
//   ZS_E2E=1 bun test tests/copy.e2e.test.js
//
// The mock mirrors the layout that caused bad notes: the thinking panel renders
// its own action menu *before* the answer's, so taking the first menu copies
// the model's reasoning as if it were the note.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { copyLatestResponseMarkdown } from "../lib/aistudio.js";

const TRACE = `**Analyzing the Input Data**

I'm carefully reviewing the provided materials. I need to understand the Bangla transcript with its English technical terms, and then reconcile it with the slide PDF.

**Reviewing the System Rules**

I'm focused now on the system rules. I'm making sure I completely understand the formatting and language constraints, especially for the Bangla context and allowed markdown.

**Refining the Extraction Process**

I'm now diving deep into refining my extraction process, specifically focusing on how to handle the detailed content rules and teacher instructions.

**Implementing the Structure**

I'm now integrating the output blocks. I am focusing on accurately translating and re-creating these visual elements within the markdown structure.

**Clarifying the Question Structure**

I'm now clarifying the structure of the questions. I am working to ensure compliance with the formatting guidelines.

**Structuring the Answers**

I'm now carefully structuring the answer sections, considering how best to present this information. I am making sure that the existing instructions guide me correctly.`;

const ANSWER = `# ১. সংখ্যা পদ্ধতি

বাইনারি যোগের নিয়ম নিচে দেওয়া হলো।

- প্রথমে ডান দিক থেকে যোগ শুরু করি।
- ক্যারি পরের ঘরে নিয়ে যাই।

${"বিস্তারিত ব্যাখ্যা। ".repeat(60)}`;

const page_html = ({ withAnswer }) => `<!doctype html>
<ms-chat-turn>
  <div class="turn">
    <div class="thoughts-panel">
      <button aria-label="Open options" data-kind="thoughts">options</button>
      <div class="trace">${TRACE}</div>
    </div>
    ${
      withAnswer
        ? `<div class="markdown"><h1>উত্তর</h1><p>${ANSWER.replace(/\n/g, " ")}</p>
             <button aria-label="Open options" data-kind="answer">options</button></div>`
        : ""
    }
  </div>
</ms-chat-turn>
<div id="menu"></div>
<script>
  const TEXT = { thoughts: ${JSON.stringify(TRACE)}, answer: ${JSON.stringify(ANSWER)} };
  document.querySelectorAll('button[aria-label="Open options"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("menu");
      menu.innerHTML = "";
      const item = document.createElement("div");
      item.textContent = "Copy as markdown";
      item.style.cssText =
        "position:fixed;top:120px;left:120px;z-index:99;background:#fff;padding:8px;border:1px solid #000";
      item.addEventListener("click", () => navigator.clipboard.writeText(TEXT[btn.dataset.kind]));
      menu.appendChild(item);
    });
  });
</script>`;

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

const e2e = process.env.ZS_E2E ? describe : describe.skip;

let server;
let browser;
let context;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const withAnswer = new URL(req.url).searchParams.get("answer") !== "0";
      return new Response(page_html({ withAnswer }), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: chromeBinary(),
    args: ["--no-sandbox"],
  });
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
});

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  server?.stop(true);
});

async function open(withAnswer) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/?answer=${withAnswer ? 1 : 0}`);
  return page;
}

e2e("copyLatestResponseMarkdown with a thinking panel", () => {
  test("copies the answer, not the reasoning trace", async () => {
    const page = await open(true);
    const text = await copyLatestResponseMarkdown(page);
    expect(text).toContain("সংখ্যা পদ্ধতি");
    expect(text).not.toContain("I'm carefully reviewing");
    await page.close();
  }, 60000);

  test("refuses a trace-only turn instead of saving it as a note", async () => {
    const page = await open(false);
    await expect(copyLatestResponseMarkdown(page)).rejects.toThrow(/reasoning trace/);
    await page.close();
  }, 60000);
});

// Sanity check for the test above: the mock really does expose a thinking
// panel whose menu copies the trace, so taking the first menu (the old
// behaviour) is what produced reasoning notes.
e2e("the mock reproduces the first-menu hazard", () => {
  test("clicking the thinking panel's menu copies the trace", async () => {
    const page = await open(true);
    await page.click('button[data-kind="thoughts"]');
    await page.click("text=Copy as markdown");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("I'm carefully reviewing");
    await page.close();
  }, 60000);
});
