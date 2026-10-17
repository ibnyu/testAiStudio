// Settings tool for the notes pipeline.
//
//   bun config.js                 show the resolved config (defaults + overrides)
//   bun config.js init            create ./config.json from the built-in defaults
//   bun config.js get <key>       print one resolved value (dotted key ok)
//   bun config.js set <key> <val> set an override (JSON parsed when possible)
//   bun config.js unset <key>     remove an override
//   bun config.js path            print the config file path
//   bun config.js models          list live AI Studio models + pick the latest Flash
//   bun config.js counters        show cumulative usage counters
//   bun config.js history [N]     show the last N history records (default 10)
import { existsSync } from "node:fs";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  deepMerge,
  deletePath,
  getPath,
  loadConfig,
  parseValue,
  readRawConfig,
  setPath,
  writeRawConfig,
} from "./lib/config.js";
import { countersPath, historyPath, readCounters, readHistory } from "./lib/state.js";

const [cmd = "show", ...rest] = process.argv.slice(2);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function showConfig() {
  const raw = readRawConfig();
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  console.log(bold(`config file: ${CONFIG_PATH}`) + (existsSync(CONFIG_PATH) ? "" : dim("  (absent — using defaults)")));
  const walk = (obj, prefix = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        walk(v, key);
      } else {
        const overridden = getPath(raw, key, undefined) !== undefined;
        const val = JSON.stringify(v);
        console.log(`  ${key.padEnd(24)} ${val}${overridden ? dim("  (set)") : ""}`);
      }
    }
  };
  walk(merged);
  console.log(dim("\nSet values live in the config file and override the defaults."));
}

function initConfig() {
  if (existsSync(CONFIG_PATH)) {
    console.log(`config already exists: ${CONFIG_PATH}`);
    return;
  }
  writeRawConfig(structuredClone(DEFAULT_CONFIG));
  console.log(`wrote ${CONFIG_PATH}`);
}

function getValue(key) {
  if (!key) {
    console.error("usage: bun config.js get <key>");
    process.exitCode = 1;
    return;
  }
  const merged = loadConfig();
  const val = getPath(merged, key, undefined);
  console.log(val === undefined ? "" : JSON.stringify(val));
}

function setValue(key, rawValue) {
  if (!key || rawValue === undefined) {
    console.error("usage: bun config.js set <key> <value>");
    process.exitCode = 1;
    return;
  }
  const cfg = readRawConfig();
  setPath(cfg, key, parseValue(rawValue));
  writeRawConfig(cfg);
  console.log(`${key} = ${JSON.stringify(getPath(cfg, key))}`);
}

function unsetValue(key) {
  if (!key) {
    console.error("usage: bun config.js unset <key>");
    process.exitCode = 1;
    return;
  }
  const cfg = readRawConfig();
  const removed = deletePath(cfg, key);
  writeRawConfig(cfg);
  console.log(removed ? `removed override: ${key}` : `no override for ${key}`);
}

async function listModels() {
  const { resolveAccount, assertBrowserProfile } = await import("./lib/account.js");
  const { launchPersistentContext } = await import("cloakbrowser");
  const { gotoNewChat } = await import("./lib/aistudio.js");
  const { discoverModels, pickLatestFlash, DEFAULT_MODEL } = await import("./lib/models.js");

  const cfg = loadConfig();
  const acct = resolveAccount(rest[0] || cfg.account);
  assertBrowserProfile(acct.userDataDir);
  const ctx = await launchPersistentContext({ userDataDir: acct.userDataDir, headless: true });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await gotoNewChat(page);
    const models = await discoverModels(page);
    if (!models.length) {
      console.log("could not read the model picker (run headed to inspect).");
      return;
    }
    const pick = pickLatestFlash(models);
    console.log(bold("AI Studio models:"));
    for (const m of models) {
      const tag = pick && m.slug === pick.slug ? dim("  <- latest Flash") : "";
      console.log(`  ${m.slug.padEnd(28)} ${m.name}${tag}`);
    }
    console.log(`\nlatest Flash: ${pick ? pick.slug : DEFAULT_MODEL}`);
  } finally {
    await ctx.close();
  }
}

function showCounters() {
  const cfg = loadConfig();
  const dir = cfg.history?.dir || "./state";
  const c = readCounters(dir);
  console.log(bold(`counters (${countersPath(dir)})`));
  console.log(JSON.stringify(c, null, 2));
}

function showHistory(n) {
  const cfg = loadConfig();
  const dir = cfg.history?.dir || "./state";
  const rows = readHistory(dir);
  console.log(bold(`history (${historyPath(dir)}) — ${rows.length} record(s)`));
  for (const rec of rows.slice(-n)) {
    console.log(
      `  ${rec.at}  ${String(rec.status).padEnd(7)} ${rec.name || rec.url || ""}` +
        (rec.error ? dim(`  ${rec.error.slice(0, 60)}`) : ""),
    );
  }
}

switch (cmd) {
  case "show":
  case "list":
    showConfig();
    break;
  case "init":
    initConfig();
    break;
  case "get":
    getValue(rest[0]);
    break;
  case "set":
    setValue(rest[0], rest[1]);
    break;
  case "unset":
  case "delete":
  case "rm":
    unsetValue(rest[0]);
    break;
  case "path":
    console.log(CONFIG_PATH);
    break;
  case "models":
  case "list-models":
    await listModels();
    break;
  case "counters":
    showCounters();
    break;
  case "history":
    showHistory(Number(rest[0]) || 10);
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    console.error("commands: show init get set unset path models counters history");
    process.exitCode = 1;
}
