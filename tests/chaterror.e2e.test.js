// End-to-end checks for reading a Google-side error notice off the page.
// Skipped by default (launches a real Chromium):
//
//   ZS_E2E=1 bun test tests/chaterror.e2e.test.js
//
// The recitation ("Full output blocked") notice can appear after a long partial
// answer, so the last turn's *tail* is scanned, not just short turns.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { readChatError } from "../lib/aistudio.js";
import { classifyChatError } from "../lib/errors.js";

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
let page;

const LONG_ANSWER = `<p>${"বাইনারি যোগের নিয়ম ও উদাহরণ। ".repeat(120)}</p>`;

const html = (turn) => `<!doctype html><body><ms-chat-turn>${turn}</ms-chat-turn></body>`;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const kind = new URL(req.url).searchParams.get("kind");
      let turn = "";
      if (kind === "short") {
        turn = `<div class="error-message">Full output blocked. Edit prompt and retry.</div>`;
      } else if (kind === "tail") {
        // No error/warning class: only the turn-tail scan can find this, which
        // is what happens when the notice is plain prose after a partial answer.
        turn = `${LONG_ANSWER}<div><span>The output was blocked because it may contain material that resembles existing copyrighted works.</span></div>`;
      } else if (kind === "note") {
        turn = `${LONG_ANSWER}<p>Copyright law protects original works; copyrighted material may be used under fair use.</p>`;
      } else if (kind === "member") {
        turn = `<p>This lecture step uses membership, so keep the member list handy.</p>`;
      }
      return new Response(html(turn), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: chromeBinary(),
    args: ["--no-sandbox"],
  });
  page = await browser.newPage();
});

afterAll(async () => {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  server?.stop(true);
});

async function open(kind) {
  await page.goto(`http://127.0.0.1:${server.port}/?kind=${kind}`);
}

e2e("readChatError", () => {
  test("reads a short blocked turn and classifies it as recitation", async () => {
    await open("short");
    const text = await readChatError(page);
    expect(text).toContain("Full output blocked");
    expect(classifyChatError(text).kind).toBe("recitation");
  }, 60000);

  test("finds the notice after a long partial answer", async () => {
    await open("tail");
    const text = await readChatError(page);
    expect(text).toContain("resembles existing copyrighted");
    expect(classifyChatError(text).kind).toBe("recitation");
  }, 60000);

  test("a note about copyright is not a block", async () => {
    await open("note");
    expect(await readChatError(page)).toBeNull();
  }, 60000);

  test("ordinary lecture prose is not a block", async () => {
    await open("member");
    expect(await readChatError(page)).toBeNull();
  }, 60000);
});
