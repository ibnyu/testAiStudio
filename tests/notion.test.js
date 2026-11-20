import { describe, expect, test } from "bun:test";
import { mdToNodes, mdToBlocks, inlineToRichText, tableBlocks, normalizeLang, requestGroups } from "../lib/notion.js";

const bigTable = (rows) => {
  const lines = ["| a | b |", "|---|---|"];
  for (let i = 0; i < rows; i++) lines.push(`| ${i} | value ${i} |`);
  return lines.join("\n");
};

describe("Notion conversion", () => {
  test("chunks a long table into several table blocks", () => {
    const blocks = mdToBlocks(bigTable(250));
    const tables = blocks.filter((b) => b.type === "table");
    expect(tables.length).toBeGreaterThan(1);
    for (const t of tables) expect(t.table.children.length).toBeLessThanOrEqual(91);
    // Every chunk repeats the header.
    expect(tables[0].table.children[0].table_row.cells[0][0].type).toBe("text");
  });

  test("keeps a short table as one block", () => {
    const tables = tableBlocks(["| a | b |", "|---|---|", "| 1 | 2 |"]);
    expect(tables).toHaveLength(1);
    expect(tables[0].table.table_width).toBe(2);
  });

  test("inline math becomes an equation rich text", () => {
    const rt = inlineToRichText("value $x^2$ end");
    expect(rt.some((r) => r.type === "equation" && r.equation.expression === "x^2")).toBe(true);
  });

  test("over-long inline math falls back to text", () => {
    const expr = "x".repeat(1200);
    const rt = inlineToRichText(`$${expr}$`);
    expect(rt.every((r) => r.type !== "equation")).toBe(true);
  });

  test("a very long display equation becomes a latex code block", () => {
    const nodes = mdToNodes(`$$${"a+b+".repeat(400)}$$`);
    expect(nodes[0].block.type).toBe("code");
    expect(nodes[0].block.code.language).toBe("latex");
  });

  test("links longer than Notion's URL cap are truncated", () => {
    const url = "https://example.com/" + "x".repeat(2500);
    const rt = inlineToRichText(`[label](${url})`);
    expect(rt[0].text.link.url.length).toBeLessThanOrEqual(2000);
  });

  test("over-long image URLs degrade to a paragraph", () => {
    const url = "https://example.com/" + "x".repeat(2500);
    const blocks = mdToBlocks(`![alt](${url})`);
    expect(blocks[0].type).toBe("paragraph");
  });

  test("normalizes unknown languages to plain text", () => {
    expect(normalizeLang("definitely-not-real")).toBe("plain text");
    expect(normalizeLang("py")).toBe("python");
  });
});

describe("Notion rich-text item cap", () => {
  // Notion rejects a block with more than 100 rich_text objects even when the
  // payload is small; inline-heavy notes hit this regularly.
  const dense = Array.from({ length: 260 }, (_, i) => `$x_{${i}}$`).join(" ");

  test("a paragraph with hundreds of inline runs is split into several blocks", () => {
    const nodes = mdToNodes(dense);
    const flat = requestGroups(nodes).flat();
    expect(flat.length).toBeGreaterThan(1);
    for (const node of flat) {
      expect(node.block.paragraph.rich_text.length).toBeLessThanOrEqual(100);
    }
    const equations = flat.reduce(
      (n, node) => n + node.block.paragraph.rich_text.filter((r) => r.type === "equation").length,
      0,
    );
    expect(equations).toBe(260);
  });

  test("splitting keeps nested list children on the last piece", () => {
    const nodes = mdToNodes(`- ${dense}\n  - nested child`);
    const flat = requestGroups(nodes).flat();
    expect(flat.length).toBeGreaterThan(1);
    const withKids = flat.filter((n) => n.children.length);
    expect(withKids).toHaveLength(1);
    expect(withKids[0].children[0].block.bulleted_list_item.rich_text[0].text.content).toBe("nested child");
  });

  test("a table cell past the cap stays within 100 runs", () => {
    const tables = tableBlocks([`| ${dense} | b |`, "|---|---|", "| 1 | 2 |"]);
    for (const cell of tables[0].table.children[0].table_row.cells) {
      expect(cell.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("oversized block splitting", () => {
  test("preserves every character of a single huge rich-text run", async () => {
    const { splitOversizedBlock } = await import("../lib/notion.js");
    const content = "x".repeat(5000);
    const block = {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content }, annotations: { bold: true } }] },
    };
    const parts = splitOversizedBlock(block);
    expect(parts.length).toBeGreaterThan(1);
    const joined = parts.map((p) => p.paragraph.rich_text[0].text.content).join("");
    expect(joined).toBe(content);
    expect(parts.every((p) => p.paragraph.rich_text[0].text.content.length <= 2000)).toBe(true);
  });
});

describe("link sanitizing", () => {
  test("keeps a real absolute link", () => {
    const rt = inlineToRichText("see [notes](https://example.com/x) here");
    const link = rt.find((t) => t.text?.link);
    expect(link.text.link.url).toBe("https://example.com/x");
  });

  test("does not emit a link for a relative/placeholder URL", () => {
    const rt = inlineToRichText("[CB'25](a) and [RUET'25-26](a)");
    expect(rt.some((t) => t.text?.link)).toBe(false);
    expect(rt.map((t) => t.text?.content || "").join("")).toContain("RUET'25-26");
  });

  test("truncates an over-long absolute URL to the cap", () => {
    const rt = inlineToRichText(`[big](https://e.com/${"x".repeat(2500)})`);
    const link = rt.find((t) => t.text?.link);
    expect(link.text.link.url.length).toBe(2000);
    expect(link.text.content).toBe("big");
  });
});
