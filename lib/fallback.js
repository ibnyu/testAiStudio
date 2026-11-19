// Multi-account / multi-model generation policy.
//
// Downloads, uploads and the Drive archive always stay on the PRIMARY account.
// A backup account only supplies its logged-in browser profile (no rclone
// remote is required), because the public Drive link is readable from any
// signed-in Google account.
//
// Policy:
//   - verification error  -> the account is unusable; next account.
//   - quota/rate limit    -> often model-specific; try the next model first,
//                           then the next account.
//   - model missing       -> next model.
//   - file load failure   -> next account (the link may be inaccessible there).
//   - truncated/invalid   -> next model (a different model may finish cleanly).
//   - recitation/copyright block -> retry the same model first (the filter is
//                           stochastic and usually passes on a fresh attempt),
//                           then try another model.
import { resolveAccount, assertBrowserProfile } from "./account.js";
import {
  asPipelineError,
  errorHint,
  isFatal,
  shouldRotateAccount,
  shouldTryNextModel,
} from "./errors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the ordered generation account list. Primary always comes first for
 * "on-failure"; "round-robin" rotates the starting account per lecture.
 * Backups need only a browser profile.
 */
export function resolveGenerationAccounts({
  primaryName,
  backups = [],
  strategy = "on-failure",
  log = () => {},
  resolve = resolveAccount,
  assertProfile = assertBrowserProfile,
} = {}) {
  const names = [];
  const seen = new Set();
  for (const n of [primaryName, ...(backups || [])]) {
    const v = String(n || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    names.push(v);
  }
  const accounts = [];
  for (const name of names) {
    const acct = resolve(name);
    try {
      assertProfile(acct.userDataDir);
    } catch (e) {
      if (name === primaryName) throw e;
      log(`backup account "${name}" unavailable: ${e.message}`);
      continue;
    }
    accounts.push({ ...acct, primary: name === primaryName, backup: name !== primaryName });
  }
  if (!accounts.length) throw new Error("no usable Google account profile");
  return { accounts, strategy: strategy === "round-robin" ? "round-robin" : "on-failure" };
}

/** Rotate the list so a different account leads each lecture. */
export function rotateAccounts(accounts, lectureIndex = 0) {
  if (!accounts.length) return accounts;
  const n = ((lectureIndex % accounts.length) + accounts.length) % accounts.length;
  return [...accounts.slice(n), ...accounts.slice(0, n)];
}

/**
 * Try `attempt({ acct, model })` across the account × model matrix.
 * Returns the first success or throws the last classified error.
 *
 * `attempt` is responsible for one full generation attempt (browser launch,
 * prompt, copy). Transient retries inside that attempt are already handled by
 * the pipeline; this layer only decides whether to change model/account.
 */
export async function generateWithFallback({
  accounts,
  models,
  attempt,
  strategy = "on-failure",
  lectureIndex = 0,
  log = () => {},
  maxAttempts = 8,
  // Google's recitation filter is stochastic, but the pipeline already retries
  // the same model (`retry.attempts`, fresh browser each time) before a failure
  // reaches this layer, so the default here is 0: go straight to the next model.
  // Raise it only if the pipeline retry loop is disabled.
  recitationRetries = 0,
  recitationDelayMs = 2000,
}) {
  const ordered = strategy === "round-robin" ? rotateAccounts(accounts, lectureIndex) : accounts;
  let attempts = 0;
  let lastError = null;

  for (const acct of ordered) {
    let accountDead = false;
    for (const model of models) {
      for (let round = 0; round <= recitationRetries; round++) {
        if (attempts >= maxAttempts) break;
        attempts++;
        const tag = acct.backup ? `backup ${acct.account}` : acct.account;
        try {
          if (attempts > 1) log(`[${tag}] trying model ${model} ...`);
          return await attempt({ acct, model });
        } catch (e) {
          const err = asPipelineError(e);
          lastError = err;
          const hint = errorHint(err);
          log(
            `[${tag}] model ${model} failed (${err.kind}): ${err.message}` +
              (hint ? ` — ${hint}.` : ""),
          );

          // No model/account change can fix these (bad location, malformed
          // request, unsupported language); stop instead of burning 8 attempts.
          if (isFatal(err)) throw err;

          if (err.kind === "recitation" && round < recitationRetries) {
            log(
              `[${tag}] the recitation (copyright) filter blocked this output — it is ` +
                `stochastic, retrying model ${model} (${round + 1}/${recitationRetries}) ...`,
            );
            await sleep(recitationDelayMs);
            continue; // same account + model
          }
          if (err.kind === "verification") {
            accountDead = true;
            break;
          }
          if (err.kind === "file_load") {
            // Retrying the same link on the same account rarely helps.
            accountDead = true;
            break;
          }
          if (shouldTryNextModel(err) || err.kind === "truncated") {
            break; // next model
          }
          if (shouldRotateAccount(err)) {
            accountDead = true;
            break;
          }
          // Unknown error: try the next model once, then the next account.
          break;
        }
      }
      if (accountDead || attempts >= maxAttempts) break;
    }
    if (attempts >= maxAttempts) break;
  }

  const detail = lastError ? `: ${lastError.message}` : "";
  const error = new Error(`all account/model combinations failed${detail}`);
  error.cause = lastError;
  error.kind = lastError?.kind || "unknown";
  throw error;
}
