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
// Notion's append-children endpoint caps a request at 100 blocks, 1000 total
// block elements (children count too) and ~500 KB. Stay comfortably below.
const MAX_ELEMENTS_PER_REQUEST = 900;
const MAX_BYTES_PER_REQUEST = 450 * 1024;
const MAX_EQUATION_CHARS = 1000;
const MAX_URL_CHARS = 2000;
const MAX_TABLE_ROWS = 90; // header + body, below Notion's 100-child table cap
// Notion rejects any block whose rich_text array holds more than 100 objects,
// regardless of payload size. Inline-heavy notes (hundreds of `$...$` runs in
// one paragraph) hit this quickly, so blocks are split at this cap too.
const MAX_RICH_TEXT_ITEMS = 100;

// Notion only accepts absolute link targets; relative/placeholder hrefs (a
// common side effect of `[CB'25](a)`-style labels) fail the whole page with
// "Invalid URL for link".
function isAbsoluteUrl(url) {
  return /^(?:https?:\/\/|mailto:|tel:)\S+$/i.test(url);
}

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
      const expr = tok.slice(1, -1);
      if (expr.length <= MAX_EQUATION_CHARS) {
        rt.push({ type: "equation", equation: { expression: expr } });
      } else {
        // Inline equations cannot be split; preserve the source as text rather
        // than failing the entire page upload.
        pushText(rt, tok);
      }
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
      const url = (link?.[2] ?? "").trim();
      // Notion rejects a link whose URL is not absolute ("Invalid URL for
      // link"). Notes contain accidental markdown such as `[CB'25](a)` where a
      // board-year label is followed by an answer marker, so keep the text and
      // drop the bogus link instead of failing the whole page.
      if (link && isAbsoluteUrl(url)) {
        rt.push({
          type: "text",
          text: { content: link[1], link: { url: url.slice(0, MAX_URL_CHARS) } },
        });
      } else {
        pushText(rt, tok);
      }
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
  // Notion caps an equation expression at 1000 chars. A longer derivation is
  // preserved as a LaTeX code block instead of being rejected.
  if (expression.length <= MAX_EQUATION_CHARS) {
    return { object: "block", type: "equation", equation: { expression } };
  }
  return codeBlock("latex", expression);
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
  if (url.length > MAX_URL_CHARS) {
    // Notion rejects over-long external URLs; keep the description as text.
    return paragraphBlock(alt || "(image omitted: URL too long)");
  }
  return { object: "block", type: "image", image: { type: "external", external: { url } } };
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** Plain text of one rich-text object (used when a cell must be flattened). */
function richTextPlain(run) {
  if (!run) return "";
  if (run.type === "equation") return `$${run.equation?.expression ?? ""}$$`;
  return run.text?.content ?? "";
}

/**
 * A table cell cannot be split across blocks, so a cell with more than 100
 * inline runs is flattened past the cap into one text object. Rare, but it
 * keeps the page uploadable instead of failing the whole note.
 */
function cellRichText(text) {
  const runs = inlineToRichText(text);
  if (runs.length <= MAX_RICH_TEXT_ITEMS) return runs;
  const kept = runs.slice(0, MAX_RICH_TEXT_ITEMS - 1);
  let tail = runs.slice(MAX_RICH_TEXT_ITEMS - 1).map(richTextPlain).join("");
  if (tail.length > MAX_RICH_TEXT) tail = tail.slice(0, MAX_RICH_TEXT - 1) + "…";
  return [...kept, textObj(tail)];
}

function tableRowBlock(cols, width) {
  const padded = [...cols];
  while (padded.length < width) padded.push("");
  return {
    object: "block",
    type: "table_row",
    table_row: { cells: padded.slice(0, width).map((c) => cellRichText(c)) },
  };
}

/**
 * Convert table rows into one or more table blocks. Notion caps a table at 100
 * child rows, so a long table is split into chunks that repeat the header.
 */
export function tableBlocks(rows) {
  const header = splitTableRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitTableRow);
  const width = Math.max(1, header.length);
  const blocks = [];
  for (let start = 0; start < bodyRows.length; start += MAX_TABLE_ROWS) {
    const chunk = bodyRows.slice(start, start + MAX_TABLE_ROWS);
    const cells = [header, ...chunk].map((cols) => tableRowBlock(cols, width));
    blocks.push({
      object: "block",
      type: "table",
      table: { table_width: width, has_column_header: true, has_row_header: false, children: cells },
    });
  }
  // A header-only table still needs one block.
  if (!blocks.length) {
    blocks.push({
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: true,
        has_row_header: false,
        children: [tableRowBlock(header, width)],
      },
    });
  }
  return blocks;
}

function tableBlock(rows) {
  return tableBlocks(rows)[0];
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
      for (const block of tableBlocks(rows)) nodes.push({ block, children: [] });
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
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // A stalled request must never hang the whole pipeline.
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    const err = new Error(`Notion ${method} ${path} request failed: ${e.message}`);
    err.retryable = true;
    throw err;
  }
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
      const retryable = e.retryable || e.status === 429 || (e.status >= 500 && e.status < 600);
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

/** All page titles currently in the database (paginated). */
async function listDatabaseTitles(token, databaseId) {
  const titleProp = await getTitlePropertyName(token, databaseId);
  const titles = new Set();
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const resp = await withRetry(() =>
      notionFetch(`/databases/${databaseId}/query`, { method: "POST", token, body }),
    );
    for (const page of resp.results || []) {
      const prop = page.properties?.[titleProp];
      const text = (prop?.title || []).map((t) => t.plain_text || "").join("").trim();
      if (text) titles.add(text);
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return titles;
}

/**
 * Existing note titles for resume, or an empty Set when Notion is unusable.
 * Never throws: a listing failure degrades resume to local-file checks only.
 */
export async function fetchExistingNoteTitles({ token, databaseId }) {
  if (!token || !databaseId) return new Set();
  try {
    return await listDatabaseTitles(token, databaseId);
  } catch (e) {
    console.warn(
      `[notion] could not list existing notes (${e.message}) — resume will use local files only.`,
    );
    return new Set();
  }
}

function countElements(nodes) {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.children && node.children.length) n += countElements(node.children);
  }
  return n;
}

function payloadBytes(blocks) {
  return Buffer.byteLength(JSON.stringify({ children: blocks }), "utf8");
}

/** Split one block whose rich text is too large for a single request. */
export function splitOversizedBlock(block) {
  const type = block.type;
  const body = block[type];
  if (!body) return [block];
  if (type === "table" && Array.isArray(body.children) && body.children.length > 1) {
    const rows = body.children;
    const mid = Math.ceil(rows.length / 2);
    return [
      { ...block, [type]: { ...body, children: rows.slice(0, mid) } },
      { ...block, [type]: { ...body, children: rows.slice(mid) } },
    ];
  }
  if (Array.isArray(body.rich_text) && body.rich_text.length > 1) {
    const rt = body.rich_text;
    const mid = Math.ceil(rt.length / 2);
    return [
      { ...block, [type]: { ...body, rich_text: rt.slice(0, mid) } },
      { ...block, [type]: { ...body, rich_text: rt.slice(mid) } },
    ];
  }
  // A single rich-text object above the limit should have been chunked at
  // MAX_RICH_TEXT; if it still overflows, split the *content* into full chunks
  // (the old half-split truncated everything after the first 1900 chars).
  if (Array.isArray(body.rich_text) && body.rich_text.length === 1) {
    const item = body.rich_text[0];
    const content = item?.text?.content || "";
    if (content.length > MAX_RICH_TEXT) {
      const parts = [];
      for (let i = 0; i < content.length; i += MAX_RICH_TEXT) {
        const text = { content: content.slice(i, i + MAX_RICH_TEXT) };
        if (item?.text?.link) text.link = item.text.link;
        parts.push({
          ...block,
          [type]: {
            ...body,
            rich_text: [
              {
                type: "text",
                text,
                ...(item?.annotations ? { annotations: item.annotations } : {}),
              },
            ],
          },
        });
      }
      return parts;
    }
  }
  return [block];
}

/** Group nodes so every request stays under count/element/byte limits. */
/** Number of rich-text objects in a block body (0 for blocks without one). */
function richTextItemCount(block) {
  const body = block[block.type];
  if (!body || !Array.isArray(body.rich_text)) return 0;
  return body.rich_text.length;
}

export function requestGroups(nodes) {
  const groups = [];
  let cur = [];
  let elems = 0;
  let bytes = 0;
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
    elems = 0;
    bytes = 0;
  };
  for (const node of nodes) {
    const e = countElements([node]);
    const b = payloadBytes([node.block]);
    if (cur.length && (cur.length >= MAX_CHILDREN_PER_REQUEST || elems + e > MAX_ELEMENTS_PER_REQUEST || bytes + b > MAX_BYTES_PER_REQUEST)) {
      flush();
    }
    const tooManyRuns = richTextItemCount(node.block) > MAX_RICH_TEXT_ITEMS;
    if (e > MAX_ELEMENTS_PER_REQUEST || b > MAX_BYTES_PER_REQUEST || tooManyRuns) {
      // Split an oversized block and re-queue its pieces. Nested children stay
      // attached to the last piece so nested lists are not lost.
      const pieces = splitOversizedBlock(node.block);
      if (pieces.length > 1) {
        pieces.forEach((piece, i) => {
          const last = i === pieces.length - 1;
          nodes.push({ block: piece, children: last ? node.children : [] });
        });
        continue;
      }
    }
    cur.push(node);
    elems += e;
    bytes += b;
  }
  flush();
  return groups;
}

// Append nodes to parentId, recursing into nested list children (Notion allows
// only ~2 levels of nesting per request, so we append children separately).
export async function pushNodes(token, parentId, nodes) {
  for (const group of requestGroups(nodes)) {
    const payload = group.map((n) => n.block);
    const resp = await withRetry(() =>
      notionFetch(`/blocks/${parentId}/children`, {
        method: "PATCH",
        token,
        body: { children: payload },
      }),
    );
    const created = resp.results || [];
    for (let k = 0; k < group.length; k++) {
      const kids = group[k].children;
      if (kids && kids.length) {
        const childId = created[k]?.id;
        if (childId) await pushNodes(token, childId, kids);
      }
    }
  }
}

/**
 * Find pages in the database whose title exactly equals `title`.
 * Returns [{ id, url, title, createdTime }].
 */
export async function findPagesByTitle({ token, databaseId, title }) {
  if (!token || !databaseId || !title) return [];
  const titleProp = await getTitlePropertyName(token, databaseId);
  const body = {
    page_size: 100,
    filter: { property: titleProp, title: { equals: title } },
  };
  const out = [];
  let cursor;
  do {
    if (cursor) body.start_cursor = cursor;
    const resp = await withRetry(() =>
      notionFetch(`/databases/${databaseId}/query`, { method: "POST", token, body }),
    );
    for (const page of resp.results || []) {
      const prop = page.properties?.[titleProp];
      const text = (prop?.title || []).map((t) => t.plain_text || "").join("").trim();
      if (text === title) {
        out.push({ id: page.id, url: page.url || page.id, title: text, createdTime: page.created_time });
      }
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Archive (soft-delete) one page so a repaired note replaces it cleanly. */
export async function archivePage({ token, pageId }) {
  if (!token || !pageId) throw new Error("archivePage needs token and pageId");
  return withRetry(() =>
    notionFetch(`/pages/${pageId}`, { method: "PATCH", token, body: { archived: true } }),
  );
}

/**
 * Create a page in a Notion database (or under a page) and fill it with the
 * Markdown rendered as native blocks. Returns the page URL.
 */
export async function pushNoteToNotion({ token, databaseId, pageId, title, markdown }) {
  if (!token) throw new Error("Notion token is missing");
  if (!databaseId && !pageId) throw new Error("Notion databaseId or pageId is required");

  const nodes = mdToNodes(markdown);
  if (!nodes.length) {
    throw new Error(
      "Refusing to create an empty Notion page: the note parsed to 0 blocks.",
    );
  }
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
  try {
    await pushNodes(token, page.id, nodes);
    // A page that exists but has no children renders as an "empty note". Verify
    // before reporting success so a failed append is retried, not silently kept.
    const check = await withRetry(() =>
      notionFetch(`/blocks/${page.id}/children?page_size=1`, { method: "GET", token }),
    );
    if (!(check.results || []).length) {
      throw new Error("Notion page was created but no blocks were appended.");
    }
  } catch (e) {
    // Never leave an orphan empty page behind after a failed push.
    await withRetry(() =>
      notionFetch(`/pages/${page.id}`, {
        method: "PATCH",
        token,
        body: { archived: true },
      }),
    ).catch(() => {});
    throw e;
  }
  return page.url || page.id;
}
