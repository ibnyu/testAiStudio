// Classification policy for Google-side failures.
//
// The recovery differs per kind, so these tests pin both the wording Google
// actually shows and the policy helpers that batch/pipeline act on. The codes
// and messages follow https://ai.google.dev/gemini-api/docs/api-errors.
import { describe, expect, test } from "bun:test";
import {
  ERROR_TEXT_RE,
  RecitationError,
  classifyChatError,
  errorHint,
  isFatal,
  isTransient,
  shouldRotateAccount,
  shouldTryNextModel,
} from "../lib/errors.js";

describe("recitation (copyright) blocks", () => {
  // Messages observed on AI Studio for a public lecture. They are stochastic:
  // the same prompt usually passes on the next attempt.
  const messages = [
    "Full output blocked. Edit prompt and retry.",
    "The output was blocked because it may contain material that resembles existing copyrighted works.",
    "Response blocked due to recitation threshold.",
    "Generated content was filtered because it may contain material that resembles copyrighted material.",
    "Finish reason: RECITATION",
  ];

  for (const msg of messages) {
    test(`classifies: ${msg.slice(0, 42)}...`, () => {
      const err = classifyChatError(msg);
      expect(err).toBeInstanceOf(RecitationError);
      expect(err.kind).toBe("recitation");
      expect(err.retryable).toBe(true);
    });
  }

  test("a lecture about copyright/recitation is not mistaken for a block", () => {
    for (const text of [
      "The teacher explained the recitation of poetry in classical Arabic literature.",
      "Copyright law protects original works; copyrighted material may be used under fair use.",
      "Students practised recitation and memorisation of the passage.",
    ]) {
      expect(classifyChatError(text).kind).not.toBe("recitation");
    }
  });

  test("policy: retry the model, keep the account, treat as transient", () => {
    const err = new RecitationError("Full output blocked.");
    expect(shouldTryNextModel(err)).toBe(true);
    expect(shouldRotateAccount(err)).toBe(false);
    expect(isTransient(err)).toBe(true);
  });

  test("ERROR_TEXT_RE sees the real page text", () => {
    for (const msg of messages) expect(ERROR_TEXT_RE.test(msg)).toBe(true);
    // Existing kinds stay covered after building the shared regex.
    expect(ERROR_TEXT_RE.test("Your account must be verified")).toBe(true);
    expect(ERROR_TEXT_RE.test("quota exceeded")).toBe(true);
  });
});

describe("Gemini API status codes", () => {
  const cases = [
    // per-minute throttling
    ["You exceeded your current quota. Quota exceeded for quota metric 'Generate requests per minute'.", "rate_limit"],
    ["429 Too Many Requests", "rate_limit"],
    ["RESOURCE_EXHAUSTED", "rate_limit"],
    // daily quota
    ["You have exceeded your current quota. Please check your plan and billing details.", "quota"],
    ["Daily quota exhausted for this model.", "quota"],
    // auth / billing / location
    ["403 PERMISSION_DENIED: The caller does not have permission", "permission"],
    ["402 PAYMENT_REQUIRED: prepay credit balance is depleted", "payment"],
    ["400 FAILED_PRECONDITION: User location is not supported for the API use.", "location"],
    // model
    ["404 MODEL_NOT_FOUND: models/gemini-9 does not exist", "model_missing"],
    ["The model `gemini-9` does not exist or you do not have access to it.", "model_missing"],
    // server
    ["500 INTERNAL: An internal error occurred", "server"],
    ["503 UNAVAILABLE: The service is temporarily unavailable", "server"],
    ["504 DEADLINE_EXCEEDED: deadline exceeded while waiting", "server"],
    // content
    ["Finish reason: MAX_TOKENS", "max_tokens"],
    ["Response blocked by safety filters", "safety"],
    ["PROHIBITED_CONTENT: the response was blocked", "safety"],
    ["SPII: sensitive personally identifiable information detected", "safety"],
    ["The input exceeds the context window of this model", "context"],
    ["UNSUPPORTED_LANGUAGE: language is not supported", "language"],
    ["CANCELLED: the request was aborted", "cancelled"],
    ["400 INVALID_ARGUMENT: invalid request payload", "invalid_request"],
  ];

  for (const [text, kind] of cases) {
    test(`${kind}: ${text.slice(0, 46)}...`, () => {
      expect(classifyChatError(text).kind).toBe(kind);
    });
  }

  test("rate limits back off and rotate; server errors are transient", () => {
    const rl = classifyChatError("429 RESOURCE_EXHAUSTED");
    expect(rl.retryable).toBe(true);
    expect(shouldTryNextModel(rl)).toBe(true);
    expect(shouldRotateAccount(rl)).toBe(true);

    const srv = classifyChatError("503 UNAVAILABLE");
    expect(srv.retryable).toBe(true);
    expect(isTransient(srv)).toBe(true);
    expect(shouldRotateAccount(srv)).toBe(false);
  });

  test("quota asks for another model, then another account", () => {
    const err = classifyChatError("Resource exhausted: quota exceeded");
    expect(err.kind).toBe("quota");
    expect(shouldTryNextModel(err)).toBe(true);
    expect(shouldRotateAccount(err)).toBe(true);
  });

  test("permission/payment rotate the account", () => {
    for (const text of ["403 PERMISSION_DENIED", "402 payment required"]) {
      const err = classifyChatError(text);
      expect(shouldRotateAccount(err)).toBe(true);
    }
  });

  test("location/language/invalid argument stop instead of burning attempts", () => {
    for (const text of [
      "User location is not supported for the API use.",
      "unsupported language",
      "400 INVALID_ARGUMENT",
    ]) {
      const err = classifyChatError(text);
      expect(isFatal(err)).toBe(true);
    }
  });

  test("max_tokens and context try the next model", () => {
    for (const text of ["Finish reason: MAX_TOKENS", "input is too long"]) {
      expect(shouldTryNextModel(classifyChatError(text))).toBe(true);
    }
  });

  test("every kind has actionable advice", () => {
    const kinds = [
      "verification", "permission", "payment", "location", "quota", "rate_limit",
      "model_missing", "recitation", "safety", "context", "max_tokens", "language",
      "cancelled", "invalid_request", "server", "file_load", "truncated", "memory",
    ];
    for (const kind of kinds) {
      const err = Object.assign(new Error(kind), { kind });
      expect(typeof errorHint(err)).toBe("string");
    }
  });
});

describe("page-text scanning avoids lecture false positives", () => {
  test("numeric codes alone are not treated as page errors", () => {
    for (const text of [
      "HTTP 429 is the status code for too many requests in the RFC.",
      "The server returned 500 and 503 during the outage exercise.",
      "The internal combustion engine was invented in the 19th century.",
      "The request was cancelled by the client in our example.",
      "Set max_tokens to 2048 in the config.",
      "RESOURCE_EXHAUSTED is a gRPC status name.",
    ]) {
      expect(ERROR_TEXT_RE.test(text)).toBe(false);
    }
  });

  test("specific UI failure phrases still match", () => {
    for (const text of [
      "Full output blocked. Edit prompt and retry.",
      "You have exceeded your current quota",
      "Model not found",
      "User location is not supported",
      "permission denied",
    ]) {
      expect(ERROR_TEXT_RE.test(text)).toBe(true);
    }
  });
});

describe("verification still rotates the account", () => {
  test("verification is not transient", () => {
    const err = classifyChatError("Your account must be verified");
    expect(err.kind).toBe("verification");
    expect(shouldRotateAccount(err)).toBe(true);
    expect(isTransient(err)).toBe(false);
  });
});
