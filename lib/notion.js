// Notion upload: convert the generated Markdown into native Notion blocks and
// push it as a page in a database (or under a parent page).
//
// Rendering notes:
//   - Display math  $$...$$  -> equation blocks (KaTeX renders automatically)
//   - Inline math   $...$    -> inline "equation" rich text objects
//   - ```mermaid fences      -> code block with language "mermaid" (renders a diagram)
// This is why math now renders without manually turning text into equation blocks:
// the API receives real equation objects, not literal dollar signs.
//
// Reference: Notion API block/rich-text docs, plus ShoyebOP/Zaknotes notion_service.py.
import { existsSync, readFileSync } from "node:fs";

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";
const MAX_RICH_TEXT = 2000;
const MAX_CHILDREN_PER_REQUEST = 100;

// ---------------------------------------------------------------- config ----
// Resolution order: environment overrides, then ./notion.json.
//   {
//     "enabled": true,
//     "token": "ntn_...",          // or "notion_secret"
//     "databaseId": "xxxxxxxx...", // database target (or "pageId" for a page parent)
//     "pageId": "..."
//   }
export function loadNotionConfig() {
  let cfg = {};
  const file = "./notion.json";
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Cannot parse ${file}: ${e.message}`);
    }
  }
  const token = process.env.NOTION_TOKEN || cfg.token || cfg.notion_secret || null;
  const databaseId =
    process.env.NOTION_DATABASE_ID || cfg.databaseId || cfg.database_id || null;
  const pageId = process.env.NOTION_PAGE_ID || cfg.pageId || cfg.page_id || null;
  const enabled = cfg.enabled !== false;
  return { token, databaseId, pageId, enabled };
}

// ------------------------------------------------------------- language ----
const CODE_LANGS = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#",
  "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran",
  "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java",
  "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
  "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix",
  "objective-c", "ocaml", "pascal", "perl", "php", "plain text", "powershell",
  "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala",
  "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog",
  "vhdl", "visual basic", "webassembly", "xml", "yaml",
]);
const LANG_ALIASES = {
  js: "javascript", ts: "typescript", py: "python", sh: "shell", zsh: "shell",
  yml: "yaml", md: "markdown", text: "plain text", txt: "plain text",
  "": "plain text", csharp: "c#", "c++": "c++", golang: "go",
};
export function normalizeLang(lang) {
  const l = (lang || "").trim().toLowerCase();
  if (CODE_LANGS.has(l)) return l;
  return LANG_ALIASES[l] || "plain text";
}

// --------------------------------------------------------------- inline ----
function textObj(content, annotations) {
  const o = { type: "text", text: { content } };
  if (annotations && Object.keys(annotations).length) o.annotations = annotations;
  return o;
}

function pushText(rt, content) {
  if (content === "") return;
  // Notion caps each text object's content at 2000 characters.
  for (let i = 0; i < content.length; i += MAX_RICH_TEXT) {
    rt.push(textObj(content.slice(i, i + MAX_RICH_TEXT)));
  }
}

// Inline styles: code, math, bold, italic, strikethrough, links. Earliest match wins.
const INLINE_RE =
  /(`[^`]+`)|(\$[^$\n]+\$)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;

// Apply an emphasis annotation to the runs produced by parsing an emphasised
// span, so nested content (e.g. inline math inside **bold**) still converts.
// Equation runs carry no annotations in Notion, so they are passed through.
function mergeAnnotations(runs, add) {
  return runs.map((r) => {
    if (r.type === "equation") return r;
    const o = { type: "text", text: r.text };
    const ann = { ...(r.annotations || {}), ...add };
    if (Object.keys(ann).length) o.annotations = ann;
    return o;
  });
}

export function inlineToRichText(text) {
  const rt = [];
  let last = 0;
  let m;
  // Per-call regex: a shared global regex's lastIndex would be clobbered by the
  // recursive calls below, causing the outer scan to restart forever.
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushText(rt, text.slice(last, m.index));
    const tok = m[0];
    const inner = (n) => inlineToRichText(tok.slice(n, -n));
    if (tok.startsWith("`")) {
      rt.push(textObj(tok.slice(1, -1), { code: true }));
    } else if (tok.startsWith("$")) {
      rt.push({ type: "equation", equation: { expression: tok.slice(1, -1) } });
    } else if (tok.startsWith("***")) {
      rt.push(...mergeAnnotations(inner(3), { bold: true, italic: true }));
    } else if (tok.startsWith("**")) {
      rt.push(...mergeAnnotations(inner(2), { bold: true }));
    } else if (tok.startsWith("__")) {
      rt.push(...mergeAnnotations(inner(2), { bold: true }));
    } else if (tok.startsWith("~~")) {
      rt.push(...mergeAnnotations(inner(2), { strikethrough: true }));
    } else if (tok.startsWith("[")) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      rt.push({ type: "text", text: { content: link[1], link: { url: link[2] } } });
    } else if (tok.startsWith("*")) {
      rt.push(...mergeAnnotations(inner(1), { italic: true }));
    } else if (tok.startsWith("_")) {
      rt.push(...mergeAnnotations(inner(1), { italic: true }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) pushText(rt, text.slice(last));
  if (!rt.length) rt.push(textObj(""));
  return rt;
}

// -------------------------------------------------------------- blocks ----
function headingBlock(level, text) {
  const t = `heading_${level}`;
  return { object: "block", type: t, [t]: { rich_text: inlineToRichText(text) } };
}
function paragraphBlock(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: inlineToRichText(text) } };
}
function quoteBlock(text) {
  return { object: "block", type: "quote", quote: { rich_text: inlineToRichText(text) } };
}
function dividerBlock() {
  return { object: "block", type: "divider", divider: {} };
}
function equationBlock(expression) {
  return { object: "block", type: "equation", equation: { expression } };
}
function codeBlock(lang, code) {
  return {
    object: "block",
    type: "code",
    code: {
      language: normalizeLang(lang),
      rich_text: chunkCode(code),
    },
  };
}
function chunkCode(code) {
  const rt = [];
  for (let i = 0; i < code.length; i += MAX_RICH_TEXT) {
    rt.push(textObj(code.slice(i, i + MAX_RICH_TEXT)));
  }
  if (!rt.length) rt.push(textObj(""));
  return rt;
}
function imageBlock(alt, url) {
  return { object: "block", type: "image", image: { type: "external", external: { url } } };
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function tableBlock(rows) {
  const header = splitTableRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitTableRow);
  const width = header.length;
  const cells = [header, ...bodyRows].map((cols) => {
    const padded = [...cols];
    while (padded.length < width) padded.push("");
    return {
      object: "block",
      type: "table_row",
      table_row: { cells: padded.slice(0, width).map((c) => inlineToRichText(c)) },
    };
  });
  return {
    object: "block",
    type: "table",
    table: { table_width: width, has_column_header: true, has_row_header: false, children: cells },
  };
}

// A parsed node is { block, children } where children are nested list nodes.
function listItemNode(item) {
  const task = item.text.match(/^\[([ xX])\]\s+(.*)$/);
  let block;
  if (task) {
    block = {
      object: "block",
      type: "to_do",
      to_do: { rich_text: inlineToRichText(task[2]), checked: task[1].toLowerCase() === "x" },
    };
  } else if (item.type === "numbered_list_item") {
    block = {
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: { rich_text: inlineToRichText(item.text) },
    };
  } else {
    block = {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: inlineToRichText(item.text) },
    };
  }
  return { block, children: item.children.map(listItemNode) };
}

function parseList(lines, start) {
  const root = [];
  const stack = []; // { indent, item }
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const m = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (m) {
      const indent = m[1].replace(/\t/g, "  ").length;
      const type = /^\d/.test(m[2]) ? "numbered_list_item" : "bulleted_list_item";
      const item = { indent, type, text: m[3], children: [] };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) stack[stack.length - 1].item.children.push(item);
      else root.push(item);
      stack.push({ indent, item });
      i++;
    } else if (/^\s*$/.test(raw)) {
      if (i + 1 < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i + 1])) {
        i++;
        continue;
      }
      break;
    } else {
      break;
    }
  }
  return { root, next: i };
}

/** Convert a Markdown string into an array of { block, children } nodes. */
export function mdToNodes(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    // Fenced code (```lang ... ```) — includes mermaid.
    const fence = stripped.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      nodes.push({ block: codeBlock(lang, body.join("\n")), children: [] });
      continue;
    }

    // Display math $$...$$ (single line or fenced over several lines).
    if (stripped.startsWith("$$")) {
      if (stripped.length > 2 && stripped.endsWith("$$")) {
        nodes.push({ block: equationBlock(stripped.slice(2, -2).trim()), children: [] });
        i++;
        continue;
      }
      const body = [stripped.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("$$")) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        body.push(lines[i].trim().replace(/\$\$$/, ""));
        i++;
      }
      nodes.push({ block: equationBlock(body.join("\n").trim()), children: [] });
      continue;
    }

    if (!stripped) {
      i++;
      continue;
    }

    // Headings (# .. ######), clamped to Notion's heading_3.
    const h = stripped.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      nodes.push({ block: headingBlock(Math.min(h[1].length, 3), h[2]), children: [] });
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^([-*_])\1{2,}$/.test(stripped)) {
      nodes.push({ block: dividerBlock(), children: [] });
      i++;
      continue;
    }

    // Table (header row + separator).
    if (
      /^\|.*\|$/.test(stripped) &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())
    ) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim());
        i++;
      }
      nodes.push({ block: tableBlock(rows), children: [] });
      continue;
    }

    // Blockquote.
    if (stripped.startsWith(">")) {
      nodes.push({ block: quoteBlock(stripped.replace(/^>\s?/, "")), children: [] });
      i++;
      continue;
    }

    // Image on its own line: ![alt](url)
    const img = stripped.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      nodes.push({ block: imageBlock(img[1], img[2]), children: [] });
      i++;
      continue;
    }

    // Lists (bulleted, numbered, task) with indentation-based nesting.
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const { root, next } = parseList(lines, i);
      for (const item of root) nodes.push(listItemNode(item));
      i = next;
      continue;
    }

    // Paragraph: consume consecutive plain lines.
    const para = [stripped];
    i++;
    while (i < lines.length) {
      const n = lines[i].trim();
      if (
        !n ||
        /^```/.test(n) ||
        n.startsWith("$$") ||
        /^(#{1,6})\s+/.test(n) ||
        /^([-*_])\1{2,}$/.test(n) ||
        /^\|.*\|$/.test(n) ||
        n.startsWith(">") ||
        /^!\[[^\]]*\]\([^)]+\)$/.test(n) ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])
      ) {
        break;
      }
      para.push(n);
      i++;
    }
    nodes.push({ block: paragraphBlock(para.join(" ")), children: [] });
  }
  return nodes;
}

/** Convenience: flat array of top-level block objects (drops nested children). */
export function mdToBlocks(markdown) {
  return mdToNodes(markdown).map((n) => n.block);
}

// ---------------------------------------------------------------- API ----
async function notionFetch(path, { method = "POST", token, body }) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function withRetry(fn, { retries = 4 } = {}) {
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600);
      if (retryable && attempt < retries) {
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 30000);
        continue;
      }
      throw e;
    }
  }
}

async function getTitlePropertyName(token, databaseId) {
  const db = await withRetry(() => notionFetch(`/databases/${databaseId}`, { method: "GET", token }));
  for (const [name, info] of Object.entries(db.properties || {})) {
    if (info.type === "title") return name;
  }
  return "title";
}

// Append nodes to parentId, recursing into nested list children (Notion allows
// only ~2 levels of nesting per request, so we append children separately).
async function pushNodes(token, parentId, nodes) {
  for (let start = 0; start < nodes.length; start += MAX_CHILDREN_PER_REQUEST) {
    const slice = nodes.slice(start, start + MAX_CHILDREN_PER_REQUEST);
    const payload = slice.map((n) => n.block);
    const resp = await withRetry(() =>
      notionFetch(`/blocks/${parentId}/children`, {
        method: "PATCH",
        token,
        body: { children: payload },
      }),
    );
    const created = resp.results || [];
    for (let k = 0; k < slice.length; k++) {
      const kids = slice[k].children;
      if (kids && kids.length) {
        const childId = created[k]?.id;
        if (childId) await pushNodes(token, childId, kids);
      }
    }
  }
}

/**
 * Create a page in a Notion database (or under a page) and fill it with the
 * Markdown rendered as native blocks. Returns the page URL.
 */
export async function pushNoteToNotion({ token, databaseId, pageId, title, markdown }) {
  if (!token) throw new Error("Notion token is missing");
  if (!databaseId && !pageId) throw new Error("Notion databaseId or pageId is required");

  const nodes = mdToNodes(markdown);
  let parent;
  let properties;
  if (databaseId) {
    const titleProp = await getTitlePropertyName(token, databaseId);
    parent = { database_id: databaseId };
    properties = { [titleProp]: { title: [{ type: "text", text: { content: title } }] } };
  } else {
    parent = { page_id: pageId };
    properties = { title: [{ type: "text", text: { content: title } }] };
  }

  const page = await withRetry(() =>
    notionFetch("/pages", { token, body: { parent, properties } }),
  );
  await pushNodes(token, page.id, nodes);
  return page.url || page.id;
}
