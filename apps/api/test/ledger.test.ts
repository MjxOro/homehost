import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import * as schema from "../src/db/schema.js";
import { DatabaseLive, type DatabaseTag } from "../src/domain/Database.js";
import { DbFailure } from "../src/domain/errors.js";
import {
  DuplicateLlmCall,
  InsufficientCredits,
  InvalidUsage,
  appendCredit,
  finishAgentRun,
  getBalance,
  recordLlmCall,
  startAgentRun,
  verifyLedger,
} from "../src/domain/ledger.js";
import type { RecordLlmCallInput } from "../src/domain/ledger.js";

// Opt-in real Postgres coverage. Each run owns a fresh schema, never the demo tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("usage ledger", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let run: <A, E>(effect: Effect.Effect<A, E, DatabaseTag>) => Promise<A>;
  let runExit: <A, E>(
    effect: Effect.Effect<A, E, DatabaseTag>,
  ) => Promise<{ error: unknown }>;

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await client`INSERT INTO users (id, name, role, tier)
                 VALUES (${id}, ${id}, 'member', 'technical')`;
    return id;
  }

  const ledgerCount = async () =>
    Number((await client`SELECT count(*)::int AS n FROM credit_ledger`)[0]!.n);

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    client = postgres(databaseUrl!, {
      connection: { search_path: namespace },
      max: 8,
    });
    const dir = new URL("../migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      await client.unsafe(await readFile(new URL(f, dir), "utf8"));
    }
    const layer = DatabaseLive(drizzle(client, { schema }));
    run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
    runExit = async (effect) => {
      const exit = await Effect.runPromise(
        effect.pipe(Effect.flip, Effect.provide(layer)),
      );
      return { error: exit };
    };
  });

  afterAll(async () => {
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });

  test("chain links across users and balances accumulate per user", async () => {
    const [alice, bob] = [await newUser(), await newUser()];
    const a1 = await run(
      appendCredit({ userId: alice, delta: 100n, reason: "purchase" }),
    );
    const b1 = await run(
      appendCredit({ userId: bob, delta: 50n, reason: "grant" }),
    );
    const a2 = await run(
      appendCredit({
        userId: alice,
        delta: -30n,
        reason: "usage",
        refType: "llm_call",
        refId: randomUUID(),
      }),
    );
    expect(a1.balanceAfter).toBe(100n);
    expect(b1.balanceAfter).toBe(50n);
    expect(a2.balanceAfter).toBe(70n);
    expect(b1.prevHash).toBe(a1.hash);
    expect(a2.prevHash).toBe(b1.hash);
    expect(await run(getBalance(alice))).toBe(70n);
    expect(await run(getBalance(bob))).toBe(50n);
    expect(await run(getBalance(await newUser()))).toBe(0n);
    // Independent recomputation of the documented formula for a stored row.
    const canonical = JSON.stringify([
      a2.userId,
      "-30",
      "70",
      "usage",
      "llm_call",
      a2.refId,
      null,
      a2.createdAt.toISOString(),
    ]);
    expect(a2.hash).toBe(
      createHash("sha256").update(`${a2.prevHash}\n${canonical}`).digest("hex"),
    );
    const verified = await run(verifyLedger());
    expect(verified.ok).toBe(true);
  });

  test("overdraft is rejected and nothing is written", async () => {
    const user = await newUser();
    await run(appendCredit({ userId: user, delta: 10n, reason: "grant" }));
    const before = await ledgerCount();
    const { error } = await runExit(
      appendCredit({ userId: user, delta: -11n, reason: "usage" }),
    );
    expect(error).toBeInstanceOf(InsufficientCredits);
    expect(await ledgerCount()).toBe(before);
    expect(await run(getBalance(user))).toBe(10n);
  });

  test("25 concurrent appends keep the chain valid and the balance exact", async () => {
    const user = await newUser();
    await run(appendCredit({ userId: user, delta: 1000n, reason: "purchase" }));
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        run(
          i % 2 === 0
            ? appendCredit({ userId: user, delta: 10n, reason: "grant" })
            : appendCredit({ userId: user, delta: -3n, reason: "usage" }),
        ),
      ),
    );
    // 13 credits of +10 and 12 debits of -3.
    expect(await run(getBalance(user))).toBe(1000n + 130n - 36n);
    expect((await run(verifyLedger())).ok).toBe(true);
  });

  test("database rejects UPDATE, DELETE and TRUNCATE on credit_ledger", async () => {
    const user = await newUser();
    await run(appendCredit({ userId: user, delta: 5n, reason: "grant" }));
    // postgres-js queries are lazy thenables; settle them as real promises first.
    const attempt = (q: PromiseLike<unknown>) => Promise.resolve(q);
    await expect(
      attempt(
        client`UPDATE credit_ledger SET delta = 999 WHERE user_id = ${user}`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      attempt(client`DELETE FROM credit_ledger WHERE user_id = ${user}`),
    ).rejects.toThrow(/append-only/);
    await expect(attempt(client`TRUNCATE credit_ledger`)).rejects.toThrow(
      /append-only/,
    );
    expect(await run(getBalance(user))).toBe(5n);
  });

  test("database rejects two rows with the same prev_hash instead of forking", async () => {
    const user = await newUser();
    const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
    const prev = hex();
    const insert = (tx: postgres.TransactionSql, hash: string) =>
      tx`INSERT INTO credit_ledger
           (user_id, delta, balance_after, reason, created_at, prev_hash, hash)
         VALUES (${user}, 1, 1, 'grant', now(), ${prev}, ${hash})`;
    // Roll back on failure so no stray rows reach the shared chain.
    await expect(
      client.begin(async (tx) => {
        await insert(tx, hex());
        await insert(tx, hex());
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("database ties reason to the sign of delta", async () => {
    const user = await newUser();
    const insert = (reason: string, delta: number) =>
      Promise.resolve(
        client`INSERT INTO credit_ledger
                 (user_id, delta, balance_after, reason, created_at, prev_hash, hash)
               VALUES (${user}, ${delta}, 5, ${reason}, now(),
                 ${createHash("sha256").update(randomUUID()).digest("hex")},
                 ${createHash("sha256").update(randomUUID()).digest("hex")})`,
      );
    await expect(insert("usage", 1)).rejects.toMatchObject({ code: "23514" });
    for (const reason of ["purchase", "grant", "refund"])
      await expect(insert(reason, -1)).rejects.toMatchObject({
        code: "23514",
      });
  });

  test("verifyLedger pinpoints a tampered row", async () => {
    const user = await newUser();
    const row = await run(
      appendCredit({ userId: user, delta: 7n, reason: "grant" }),
    );
    await run(appendCredit({ userId: user, delta: 1n, reason: "grant" }));
    const setDelta = async (delta: bigint) => {
      // Table owner in the scratch schema: disable the guard, alter, re-enable.
      await client.unsafe(
        "ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_no_update_delete",
      );
      try {
        await client`UPDATE credit_ledger SET delta = ${delta.toString()}::bigint WHERE id = ${row.id.toString()}::bigint`;
      } finally {
        await client.unsafe(
          "ALTER TABLE credit_ledger ENABLE TRIGGER credit_ledger_no_update_delete",
        );
      }
    };
    await setDelta(8n);
    try {
      const result = await run(verifyLedger());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.brokenAtId).toBe(row.id);
        expect(result.reason).toBe("hash");
      }
    } finally {
      await setDelta(row.delta);
    }
    expect((await run(verifyLedger())).ok).toBe(true);
  });

  describe("llm calls and agent runs", () => {
    const call = (
      over: Partial<RecordLlmCallInput> = {},
    ): RecordLlmCallInput => ({
      purpose: "bench",
      provider: "prov",
      model: "model-x",
      providerRequestId: randomUUID(),
      promptHash: createHash("sha256").update(randomUUID()).digest("hex"),
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 1234n,
      priceTableVersion: "v1",
      latencyMs: 250,
      status: "ok",
      ...over,
    });

    test("provider request id is unique per provider; null ids never collide", async () => {
      const requestId = randomUUID();
      const first = await run(
        recordLlmCall(call({ providerRequestId: requestId })),
      );
      expect(first.costMicroUsd).toBe(1234n);
      const { error } = await runExit(
        recordLlmCall(call({ providerRequestId: requestId })),
      );
      expect(error).toBeInstanceOf(DuplicateLlmCall);
      await run(
        recordLlmCall(
          call({ providerRequestId: requestId, provider: "other" }),
        ),
      );
      await run(recordLlmCall(call({ providerRequestId: null })));
      await run(recordLlmCall(call({ providerRequestId: null })));
    });

    test("negative tokens or cost are rejected before the database", async () => {
      for (const bad of [
        call({ inputTokens: -1 }),
        call({ outputTokens: 1.5 }),
        call({ latencyMs: -5 }),
        call({ costMicroUsd: -1n }),
      ]) {
        const { error } = await runExit(recordLlmCall(bad));
        expect(error).toBeInstanceOf(InvalidUsage);
      }
      const { error } = await runExit(
        recordLlmCall(call({ promptHash: "nope" })),
      );
      expect(error).toBeInstanceOf(InvalidUsage);
      expect(error).not.toBeInstanceOf(DbFailure);
    });

    test("agent runs start running for a user or none, and finish once", async () => {
      const bench = await run(
        startAgentRun({ kind: "bench", purpose: "bench" }),
      );
      expect(bench.userId).toBeNull();
      expect(bench.status).toBe("running");
      const done = await run(finishAgentRun(bench.id, "succeeded"));
      expect(done.status).toBe("succeeded");
      expect(done.finishedAt).not.toBeNull();
      const { error } = await runExit(finishAgentRun(bench.id, "failed"));
      expect(error).toMatchObject({ _tag: "AgentRunNotRunning" });
      const user = await newUser();
      const owned = await run(
        startAgentRun({
          userId: user,
          kind: "site_build",
          purpose: "prod",
          refType: "site",
          refId: randomUUID(),
        }),
      );
      const linked = await run(
        recordLlmCall(
          call({ agentRunId: owned.id, userId: user, purpose: "prod" }),
        ),
      );
      expect(linked.agentRunId).toBe(owned.id);
    });
  });
});
