// Typed errors + classification for AI Studio / Google-side failures.
//
// The pipeline needs to distinguish *what* went wrong because the recovery
// differs. The taxonomy follows Google's published Gemini API error model
// (https://ai.google.dev/gemini-api/docs/api-errors) and troubleshooting guide
// (https://ai.google.dev/gemini-api/docs/troubleshooting):
//
//   kind             typical source                         recovery
//   ---------------- -------------------------------------- ----------------------------
//   verification     AI Studio account gate                 next account
//   permission       PERMISSION_DENIED / 403                next account
//   payment          PAYMENT_REQUIRED / 402 / credits      next account (or add credits)
//   location         "location is not supported"            fatal (no retry helps)
//   quota            QUOTA_EXCEEDED / daily quota           next model, then account
//   rate_limit       RESOURCE_EXHAUSTED / 429 / per-minute  backoff, next model
//   model_missing    MODEL_NOT_FOUND / unknown slug         next model
//   file_load        Drive link failed to attach           next account
//   recitation       RECITATION finish reason               retry (stochastic), next model
//   safety           SAFETY / PROHIBITED_CONTENT / SPII     next model (same prompt may fail)
//   context          INVALID_ARGUMENT: too many tokens      next model
//   max_tokens       MAX_TOKENS finish reason               regenerate / next model
//   language         unsupported language                   fatal for this prompt
//   cancelled        CANCELLED / 499                        transient retry
//   invalid_request  INVALID_ARGUMENT / malformed request   fatal (our prompt/request)
//   server           INTERNAL / UNAVAILABLE / 5xx timeout   backoff and retry
//   truncated        note ended mid-way (validated locally) regenerate this part
//   unknown          anything else                          retry, then rotate
//
// Every error carries `kind` and `retryable`. `shouldRotateAccount` and
// `shouldTryNextModel` encode the policy in one place so batch/pipeline agree.

export class PipelineError extends Error {
  constructor(message, { kind = "unknown", retryable = false, cause = null } = {}) {
    super(message);
    this.name = "PipelineError";
    this.kind = kind;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export class VerificationError extends PipelineError {
  constructor(message = "This Google account must be verified before AI Studio can be used.") {
    super(message, { kind: "verification", retryable: false });
    this.name = "VerificationError";
  }
}

export class PermissionError extends PipelineError {
  constructor(message = "This Google account does not have permission to use the model (403 PERMISSION_DENIED).") {
    super(message, { kind: "permission", retryable: false });
    this.name = "PermissionError";
  }
}

export class PaymentError extends PipelineError {
  constructor(message = "Google requires billing/credits for this account (402 PAYMENT_REQUIRED).") {
    super(message, { kind: "payment", retryable: false });
    this.name = "PaymentError";
  }
}

export class LocationError extends PipelineError {
  constructor(message = "AI Studio is not available in this account's location.") {
    super(message, { kind: "location", retryable: false });
    this.name = "LocationError";
  }
}

export class QuotaError extends PipelineError {
  constructor(message = "AI Studio quota exhausted for this account/model (429 QUOTA_EXCEEDED).") {
    super(message, { kind: "quota", retryable: false });
    this.name = "QuotaError";
  }
}

export class RateLimitError extends PipelineError {
  constructor(message = "AI Studio is rate-limiting requests (429 RESOURCE_EXHAUSTED).") {
    super(message, { kind: "rate_limit", retryable: true });
    this.name = "RateLimitError";
  }
}

export class ModelUnavailableError extends PipelineError {
  constructor(message = "The requested AI Studio model is not available (404 MODEL_NOT_FOUND).") {
    super(message, { kind: "model_missing", retryable: false });
    this.name = "ModelUnavailableError";
  }
}

export class FileLoadError extends PipelineError {
  constructor(message = "AI Studio could not load the attached Drive file.") {
    super(message, { kind: "file_load", retryable: true });
    this.name = "FileLoadError";
  }
}

export class RecitationError extends PipelineError {
  constructor(message = "The response was blocked by Google's recitation (copyright) filter.") {
    super(message, { kind: "recitation", retryable: true });
    this.name = "RecitationError";
  }
}

export class SafetyError extends PipelineError {
  constructor(message = "Google's safety/policy filter blocked the request.") {
    super(message, { kind: "safety", retryable: false });
    this.name = "SafetyError";
  }
}

export class ContextError extends PipelineError {
  constructor(message = "The prompt/context is too long for this model.") {
    super(message, { kind: "context", retryable: false });
    this.name = "ContextError";
  }
}

export class MaxTokensError extends PipelineError {
  constructor(message = "The model reached its output-token limit (MAX_TOKENS); the note is incomplete.") {
    super(message, { kind: "max_tokens", retryable: false });
    this.name = "MaxTokensError";
  }
}

export class LanguageError extends PipelineError {
  constructor(message = "The request language is not supported by this model.") {
    super(message, { kind: "language", retryable: false });
    this.name = "LanguageError";
  }
}

export class CancelledError extends PipelineError {
  constructor(message = "The request was cancelled before it completed (499).") {
    super(message, { kind: "cancelled", retryable: true });
    this.name = "CancelledError";
  }
}

export class InvalidRequestError extends PipelineError {
  constructor(message = "Google rejected the request as invalid (400 INVALID_ARGUMENT).") {
    super(message, { kind: "invalid_request", retryable: false });
    this.name = "InvalidRequestError";
  }
}

export class ServerError extends PipelineError {
  constructor(message = "Google's service failed or timed out (5xx); retry with backoff.") {
    super(message, { kind: "server", retryable: true });
    this.name = "ServerError";
  }
}

export class TruncatedNoteError extends PipelineError {
  constructor(message = "The generated note is incomplete/truncated.", issues = []) {
    super(message, { kind: "truncated", retryable: false });
    this.name = "TruncatedNoteError";
    this.issues = issues;
  }
}

// Order matters. The most specific messages are tested first; in particular the
// per-minute quota text must be classified as a rate limit *before* the generic
// "quota exceeded" rule sees it.
const PATTERNS = [
  {
    kind: "verification",
    re: /(verify[\s-]?account|account must be verified|verification#verify-account|verify your account|account verification required|verify (?:your )?age)/i,
    textRe: /(verify[\s-]?account|account must be verified|verification#verify-account|verify your account|account verification required)/i,
  },
  // Recitation = the output closely matched training data, so generation was
  // stopped. It fires on public, non-infringing study material too (textbook
  // definitions in a Bangla lecture are exactly what the model has memorised),
  // so it must be retried, not treated as a fatal refusal.
  {
    kind: "recitation",
    re: /(full output blocked|blocked due to recitation|recitation (?:filter|block|detected|threshold)|blocked (?:by|due to) (?:copyright|recitation)|copyright(?:ed)? (?:material|content|works?) (?:was )?(?:detected|blocked)|resembles (?:existing )?copyrighted|may contain material that resembles|generated content was filtered|finish[_ ]?reason[^.]*RECITATION|edit prompt and retry)/i,
  },
  {
    kind: "location",
    re: /(location is not supported|not available in your (?:country|region)|unsupported (?:country|region|location)|user location[^.]*not supported|FAILED_PRECONDITION[^.]*location)/i,
    textRe: /(location is not supported|unsupported (?:country|region|location)|user location[^.]*not supported)/i,
  },
  {
    kind: "payment",
    re: /(payment required|402|credit balance (?:is )?(?:depleted|exhausted)|prepay(?:ment)? (?:credit|balance)|billing (?:account )?(?:disabled|required|issue|problem)|add credits)/i,
    textRe: /(payment required|credit balance (?:is )?(?:depleted|exhausted)|prepay(?:ment)? (?:credit|balance)|billing (?:account )?(?:disabled|required|issue|problem)|add credits)/i,
  },
  {
    kind: "permission",
    re: /(permission[_ ]denied|permission denied|api key not valid|invalid api key|unauthenticated|\b(?:error|code|status|http)[^.]{0,12}\b401\b|\b(?:error|code|status|http)[^.]{0,12}\b403\b|does not have (?:the )?permission|not authorized to use)/i,
    textRe: /(permission[_ ]denied|permission denied|api key not valid|invalid api key|unauthenticated|does not have (?:the )?permission|not authorized to use)/i,
  },
  {
    kind: "model_missing",
    re: /(specified model (?:was )?not (?:recognized|found)|model[_ ]not[_ ]found|models\/[\w.-]+[^.]*(?:does not exist|not found)|model (?:could not be found|is not available|not found|does not exist)|does not exist or you do not have access|default model will be used|unknown model|invalid model|no such model)/i,
    textRe: /(specified model (?:was )?not (?:recognized|found)|model[_ ]not[_ ]found|models\/[\w.-]+[^.]*(?:does not exist|not found)|model (?:could not be found|is not available|does not exist)|does not exist or you do not have access)/i,
  },
  {
    kind: "file_load",
    re: /(failed to (?:load|attach|fetch) (?:the )?file|file (?:failed|could not be) (?:loaded|attached)|unsupported file|file is too large|could not download (?:the )?file)/i,
    textRe: /(failed to (?:load|attach|fetch) (?:the )?file|file (?:failed|could not be) (?:loaded|attached)|could not download (?:the )?file)/i,
  },
  {
    kind: "context",
    re: /(context (?:length|window)|input is too long|too many tokens|prompt is too long|exceeds? the (?:maximum )?(?:input|context) (?:token|length)|token count[^.]*exceed)/i,
    textRe: /(context (?:length|window)[^.]{0,40}(?:exceed|too long|limit)|input is too long|too many tokens|prompt is too long)/i,
  },
  {
    kind: "max_tokens",
    re: /(max[_ ]?tokens|maximum (?:output )?tokens|output token limit|token limit (?:was )?(?:reached|exceeded)|finish[_ ]?reason[^.]*MAX_TOKENS)/i,
    textScan: false,
  },
  // 429 per-minute throttling. Google's message often says "Quota exceeded for
  // quota metric ... per minute", so this must precede the daily-quota rule.
  {
    kind: "rate_limit",
    re: /(rate[\s-]?limit|too many requests|try again (?:later|in a few)|quota exceeded[^.]*per (?:minute|second|100 seconds)|per (?:minute|second) (?:quota|limit)|temporarily throttled)/i,
    textRe: /(rate[\s-]?limit|quota exceeded[^.]*per (?:minute|second|100 seconds)|per (?:minute|second) (?:quota|limit)|temporarily throttled)/i,
  },
  {
    kind: "quota",
    re: /(quota (?:exceeded|exhausted|reached)|exceeded your (?:current )?quota|out of quota|no quota (?:left|remaining)|daily quota|quota (?:metric|limit)|per day quota|billing quota|free tier limit|quota_exceeded)/i,
    textRe: /(quota (?:exceeded|exhausted|reached)|exceeded your (?:current )?quota|out of quota|no quota (?:left|remaining)|quota_exceeded)/i,
  },
  // Bare gRPC status, only safe in a banner/error message (a gRPC lecture could
  // print it verbatim). "Quota exceeded" already won above, so this is a
  // throttle by default.
  {
    kind: "rate_limit",
    re: /(\b429\b|resource[_ ]exhausted|\bRESOURCE_EXHAUSTED\b)/i,
    textScan: false,
  },
  {
    kind: "server",
    re: /(internal (?:server )?error|service unavailable|overloaded|high demand|deadline exceeded|temporarily unavailable|server had an error|try again later|\b(?:error|code|status|http)[^.]{0,12}\b5(?:00|02|03|04)\b|\bUNAVAILABLE\b|\bINTERNAL\b|\bDEADLINE_EXCEEDED\b)/i,
    textRe: /(internal (?:server )?error|service unavailable|overloaded|high demand|deadline exceeded|temporarily unavailable|server had an error|try again later)/i,
  },
  {
    kind: "safety",
    re: /(blocked by safety|safety (?:filter|policy|violation)|content policy|response was blocked|prohibited[_ ]content|sensitive (?:personally identifiable )?information|\bspii\b|blocklist|jailbreak|content[_ ]blocked|input blocked|image[_ ]safety|policy violation)/i,
    textRe: /(blocked by safety|safety filter|response was blocked|prohibited[_ ]content|\bspii\b|content[_ ]blocked|input blocked)/i,
  },
  {
    kind: "language",
    re: /(unsupported language|language is not supported|language not supported|unsupported[_ ]language)/i,
    textRe: /(unsupported language|language is not supported|language not supported|unsupported[_ ]language)/i,
  },
  {
    kind: "cancelled",
    re: /(request (?:was )?cancelled|request (?:was )?aborted|client closed request|\b499\b|\bCANCELLED\b)/i,
    textScan: false,
  },
  {
    kind: "invalid_request",
    re: /(invalid[_ ]argument|invalid request|malformed request|bad request|invalid parameter|\b(?:error|code|status|http)[^.]{0,12}\b400\b)/i,
    textRe: /(invalid[_ ]argument|invalid request|malformed request|invalid parameter)/i,
  },
];

const CLASSES = {
  verification: VerificationError,
  permission: PermissionError,
  payment: PaymentError,
  location: LocationError,
  quota: QuotaError,
  rate_limit: RateLimitError,
  model_missing: ModelUnavailableError,
  file_load: FileLoadError,
  recitation: RecitationError,
  safety: SafetyError,
  context: ContextError,
  max_tokens: MaxTokensError,
  language: LanguageError,
  cancelled: CancelledError,
  invalid_request: InvalidRequestError,
  server: ServerError,
};

/**
 * Classify an arbitrary error message. Returns a PipelineError so callers can
 * `throw classifyChatError(text)` and rely on `.kind`/`.retryable`.
 */
export function classifyChatError(text, fallbackMessage = null) {
  const msg = String(text || "").trim();
  const probe = msg || fallbackMessage || "Unknown AI Studio error";
  for (const { kind, re } of PATTERNS) {
    if (re.test(probe)) {
      const Ctor = CLASSES[kind];
      return Ctor ? new Ctor(probe) : new PipelineError(probe, { kind, retryable: false });
    }
  }
  return new PipelineError(probe, { kind: "unknown", retryable: true });
}

/** Normalize a plain Error into a PipelineError without losing its message. */
export function asPipelineError(error) {
  if (error instanceof PipelineError) return error;
  const msg = error?.message || String(error || "Unknown error");
  // Preserve an explicit kind set by a lower-level helper (e.g. the memory
  // guard, or an error rethrown from a classified failure).
  if (error && typeof error.kind === "string" && error.kind) {
    const wrapped = new PipelineError(msg, {
      kind: error.kind,
      retryable: error.retryable === true,
      cause: error,
    });
    return wrapped;
  }
  const classified = classifyChatError(msg);
  // Preserve an explicit retryable flag set by lower-level helpers.
  if (error && typeof error.retryable === "boolean") classified.retryable = error.retryable;
  classified.cause = error;
  return classified;
}

/** An account-wide failure means the next account should be tried. */
export function shouldRotateAccount(error) {
  const e = asPipelineError(error);
  return ["verification", "permission", "payment", "quota", "rate_limit"].includes(e.kind);
}

/** A model-specific failure means the next model should be tried first. */
export function shouldTryNextModel(error) {
  const e = asPipelineError(error);
  return [
    "model_missing",
    "quota",
    "rate_limit",
    "context",
    "recitation",
    "max_tokens",
  ].includes(e.kind);
}

/** Retry the same account/model (transient browser/file/network flakes). */
export function isTransient(error) {
  const e = asPipelineError(error);
  if (e.retryable) return true;
  return ["file_load", "unknown", "recitation"].includes(e.kind);
}

/** Kinds where no account/model change can help: fail the lecture immediately. */
export function isFatal(error) {
  const e = asPipelineError(error);
  return ["location", "invalid_request", "language", "memory"].includes(e.kind);
}

/** One-line, actionable advice for a classified failure (used in run logs). */
export function errorHint(error) {
  const e = asPipelineError(error);
  switch (e.kind) {
    case "verification":
      return "this Google account must be verified; using a backup account";
    case "permission":
      return "account has no access to this model; using a backup account";
    case "payment":
      return "credits/billing required for this account; using a backup account";
    case "location":
      return "AI Studio is unavailable in this account's location";
    case "quota":
      return "daily quota exhausted; trying another model, then account";
    case "rate_limit":
      return "per-minute rate limit; backing off and trying another model";
    case "model_missing":
      return "model not found; trying the next model";
    case "recitation":
      return "recitation filter fired (content-based and stochastic); regenerating";
    case "safety":
      return "safety/policy filter blocked the request";
    case "context":
      return "prompt exceeds the model's context window; trying a larger model";
    case "max_tokens":
      return "output token limit reached; regenerating with the next model";
    case "language":
      return "unsupported language for this model";
    case "cancelled":
      return "request cancelled; retrying";
    case "invalid_request":
      return "Google rejected the request as malformed; check the prompt/attachment";
    case "server":
      return "Google-side 5xx; retrying with backoff";
    case "file_load":
      return "attached Drive file failed to load";
    case "truncated":
      return "note ended mid-way; regenerating this part";
    case "memory":
      return "not enough free RAM/swap; close other apps and retry";
    default:
      return null;
  }
}

/**
 * Conservative regex for scanning *page text* (the last chat turn), built from
 * the patterns that are unambiguous UI failure phrases. Numeric status codes
 * and generic words are deliberately excluded: a lecture on networking can
 * legitimately contain "429", "internal", "cancelled", or "token limit", and a
 * false positive aborts a good generation.
 */
export const ERROR_TEXT_RE = new RegExp(
  `(${PATTERNS.filter((p) => p.textScan !== false)
    .map((p) => (p.textRe || p.re).source)
    .join("|")})`,
  "i",
);

/**
 * Full regex for *error banners / snackbars*, where short numeric codes are
 * safe to trust. `classifyChatError` uses the same patterns.
 */
export const BANNER_ERROR_RE = new RegExp(
  `(${PATTERNS.map((p) => p.re.source).join("|")})`,
  "i",
);
