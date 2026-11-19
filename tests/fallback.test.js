import { describe, expect, test } from "bun:test";
import { resolveGenerationAccounts, rotateAccounts, generateWithFallback } from "../lib/fallback.js";
import {
  VerificationError,
  QuotaError,
  RateLimitError,
  ModelUnavailableError,
  FileLoadError,
  RecitationError,
  TruncatedNoteError,
} from "../lib/errors.js";

const resolve = (name) => ({
  account: name,
  userDataDir: `./auth/${name}`,
  rcloneConfig: `./auth/${name}/rclone.conf`,
  rcloneRemote: `${name}:`,
  workDir: `./tmp/${name}`,
});
const has = (...present) => (dir) => {
  const name = dir.split("/").pop();
  if (!present.includes(name)) throw new Error(`Browser profile "${dir}" not found.`);
};

const acct = (name, primary = false) => ({ ...resolve(name), primary, backup: !primary });

describe("resolveGenerationAccounts", () => {
  test("primary leads and duplicate backups collapse", () => {
    const logs = [];
    const { accounts, strategy } = resolveGenerationAccounts({
      primaryName: "ibny",
      backups: ["backup", "ibny", "backup", " "],
      resolve,
      assertProfile: has("ibny", "backup"),
      log: (m) => logs.push(m),
    });
    expect(accounts.map((a) => a.account)).toEqual(["ibny", "backup"]);
    expect(accounts[0].primary).toBe(true);
    expect(accounts[1].backup).toBe(true);
    expect(strategy).toBe("on-failure");
    expect(logs).toHaveLength(0);
  });

  test("a backup without a browser profile is skipped, not fatal", () => {
    const logs = [];
    const { accounts } = resolveGenerationAccounts({
      primaryName: "ibny",
      backups: ["missing"],
      resolve,
      assertProfile: has("ibny"),
      log: (m) => logs.push(m),
    });
    expect(accounts.map((a) => a.account)).toEqual(["ibny"]);
    expect(logs[0]).toContain("missing");
  });

  test("a missing primary profile is fatal", () => {
    expect(() =>
      resolveGenerationAccounts({ primaryName: "ibny", backups: [], resolve, assertProfile: has() }),
    ).toThrow(/not found/);
  });

  test("unknown strategies normalize to on-failure", () => {
    const { strategy } = resolveGenerationAccounts({
      primaryName: "ibny",
      strategy: "nonsense",
      resolve,
      assertProfile: has("ibny"),
    });
    expect(strategy).toBe("on-failure");
  });
});

describe("rotateAccounts", () => {
  test("round-robin moves a different account to the front per lecture", () => {
    const list = [acct("a", true), acct("b"), acct("c")];
    expect(rotateAccounts(list, 0).map((a) => a.account)).toEqual(["a", "b", "c"]);
    expect(rotateAccounts(list, 1).map((a) => a.account)).toEqual(["b", "c", "a"]);
    expect(rotateAccounts(list, 4).map((a) => a.account)).toEqual(["b", "c", "a"]);
    expect(rotateAccounts([], 2)).toEqual([]);
  });
});

describe("generateWithFallback", () => {
  const accounts = [acct("ibny", true), acct("backup")];
  const models = ["m1", "m2"];

  test("returns the first success with its model and account", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        return { model, account: a.account };
      },
    });
    expect(res).toEqual({ model: "m1", account: "ibny" });
    expect(calls).toEqual(["ibny/m1"]);
  });

  test("quota tries the next model on the same account", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (model === "m1") throw new QuotaError();
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m2"]);
    expect(res.account).toBe("ibny");
  });

  test("verification skips the rest of that account's models", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (a.account === "ibny") throw new VerificationError();
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "backup/m1"]);
    expect(res.account).toBe("backup");
  });

  test("file-load failure moves to the next account", async () => {
    const calls = [];
    await generateWithFallback({
      accounts,
      models,
      attempt: async ({ acct: a }) => {
        calls.push(a.account);
        if (a.account === "ibny") throw new FileLoadError();
        return { account: a.account };
      },
    });
    expect(calls).toEqual(["ibny", "backup"]);
  });

  test("model_missing and truncated walk the model chain first", async () => {
    for (const err of [new ModelUnavailableError(), new TruncatedNoteError()]) {
      const calls = [];
      const res = await generateWithFallback({
        accounts,
        models,
        attempt: async ({ acct: a, model }) => {
          calls.push(`${a.account}/${model}`);
          if (model === "m1") throw err;
          return { model, account: a.account };
        },
      });
      expect(calls).toEqual(["ibny/m1", "ibny/m2"]);
      expect(res.model).toBe("m2");
    }
  });

  test("recitation moves straight to the next model by default", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      recitationDelayMs: 0,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (model === "m1") throw new RecitationError("Full output blocked.");
        return { model, account: a.account };
      },
    });
    // The pipeline already retried m1 (fresh browser each time); do not stack
    // another retry layer here.
    expect(calls).toEqual(["ibny/m1", "ibny/m2"]);
    expect(res).toEqual({ model: "m2", account: "ibny" });
  });

  test("an explicit retry budget retries the same model first", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      recitationRetries: 2,
      recitationDelayMs: 0,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (calls.length === 1) throw new RecitationError("Full output blocked.");
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m1"]);
    expect(res).toEqual({ model: "m1", account: "ibny" });
  });

  test("recitation keeps retrying the same model up to the limit, then moves on", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      recitationDelayMs: 0,
      recitationRetries: 2,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (model === "m1") throw new RecitationError();
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m1", "ibny/m1", "ibny/m2"]);
    expect(res.model).toBe("m2");
  });

  test("recitation that blocks every model moves to the backup account", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      recitationDelayMs: 0,
      recitationRetries: 1,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (a.account === "ibny") throw new RecitationError();
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m1", "ibny/m2", "ibny/m2", "backup/m1"]);
    expect(res.account).toBe("backup");
  });

  test("recitationRetries: 0 disables the same-model retry", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      recitationRetries: 0,
      recitationDelayMs: 0,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (model === "m1") throw new RecitationError();
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m2"]);
    expect(res.model).toBe("m2");
  });

  test("maxAttempts still caps a recitation retry loop", async () => {
    const calls = [];
    await generateWithFallback({
      accounts,
      models,
      recitationDelayMs: 0,
      recitationRetries: 10,
      maxAttempts: 3,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        throw new RecitationError();
      },
    }).catch(() => {});
    expect(calls).toHaveLength(3);
  });

  test("unknown errors also try the next model", async () => {
    const calls = [];
    await generateWithFallback({
      accounts,
      models,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (model === "m1") throw new Error("something odd");
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m2"]);
  });

  test("rate limit tries every model before the next account", async () => {
    const calls = [];
    const res = await generateWithFallback({
      accounts,
      models,
      attempt: async ({ acct: a, model }) => {
        calls.push(`${a.account}/${model}`);
        if (a.account === "ibny") throw new RateLimitError();
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["ibny/m1", "ibny/m2", "backup/m1"]);
    expect(res.account).toBe("backup");
  });

  test("exhausting the matrix throws with the last kind", async () => {
    const err = await generateWithFallback({
      accounts,
      models,
      attempt: async () => {
        throw new QuotaError("no quota");
      },
    }).catch((e) => e);
    expect(err.message).toContain("all account/model combinations failed");
    expect(err.kind).toBe("quota");
  });

  test("maxAttempts caps the matrix", async () => {
    let n = 0;
    await generateWithFallback({
      accounts,
      models,
      maxAttempts: 2,
      attempt: async () => {
        n++;
        throw new QuotaError();
      },
    }).catch(() => {});
    expect(n).toBe(2);
  });

  test("round-robin starts with a different account per lecture", async () => {
    const calls = [];
    await generateWithFallback({
      accounts,
      models,
      strategy: "round-robin",
      lectureIndex: 1,
      attempt: async ({ acct: a, model }) => {
        calls.push(a.account);
        return { model, account: a.account };
      },
    });
    expect(calls).toEqual(["backup"]);
  });
});
