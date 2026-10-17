// Zaknotes v2 — CLI help.
//
// Single source of truth: USAGE.md at the repo root. The `--help` flag of each
// script prints it verbatim, so the guide never drifts from a second copy.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const USAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "USAGE.md");

export function usageText() {
  try {
    if (existsSync(USAGE_PATH)) return readFileSync(USAGE_PATH, "utf8").trimEnd();
  } catch {
    // fall through
  }
  return "Zaknotes v2 — USAGE.md not found next to the scripts.";
}

export function printUsage() {
  process.stdout.write(usageText() + "\n");
}
