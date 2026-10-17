// Retry helper with capped exponential backoff + jitter.
// The pipeline marks recoverable errors with `err.retryable = true`; this
// helper retries only those and re-throws everything else immediately.
export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Delay for a given (1-based) attempt: base * 2^(attempt-1), capped, +jitter. */
export function backoffDelay(attempt, { baseDelayMs = 5000, maxDelayMs = 60000 } = {}) {
  const raw = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = Math.floor(raw * 0.2 * Math.random());
  return raw + jitter;
}

/**
 * Run `fn(attempt)` up to `attempts` times. Retries only errors with
 * `err.retryable === true`, waiting a capped exponential backoff between tries.
 * `onRetry({ attempt, nextAttempt, delayMs, error })` is called before each wait.
 */
export async function withBackoff(
  fn,
  { attempts = 3, baseDelayMs = 5000, maxDelayMs = 60000, onRetry, sleep = defaultSleep } = {},
) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (!e || !e.retryable || attempt >= attempts) throw e;
      const delayMs = backoffDelay(attempt, { baseDelayMs, maxDelayMs });
      if (onRetry) onRetry({ attempt, nextAttempt: attempt + 1, delayMs, error: e });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
