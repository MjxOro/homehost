import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect, Either } from "effect";
import type { FastifyInstance } from "fastify";
import type { PortalUser, Suggestion } from "@homehost/shared";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import type { Database } from "../src/db/client.js";
import { DatabaseLive } from "../src/domain/Database.js";
import {
  ConciergeCapReached,
  ConciergeConfigTag,
  ConciergeUpstream,
  suggest,
  type ConciergeConfig,
} from "../src/domain/concierge.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const JEV_MODEL_REPORTED = "typesafe/jev-1.13-20260901";

type Reply = { status: number; body: unknown } | "hang";

interface SentCall {
  url: string;
  authorization: string | null;
  body: string;
}

/** Scripted OpenRouter: answers in order and records exactly what was sent. */
function fakeTransport(replies: Reply[]) {
  const calls: SentCall[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body: String(init?.body),
    });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected provider call");
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function jevReply(
  o: { isEnglish?: number; useCaseConfidence?: number; cost?: number } = {},
): Reply {
  return {
    status: 200,
    body: {
      id: `dec-${randomUUID()}`,
      model: JEV_MODEL_REPORTED,
      answers: {
        use_case: {
          type: "choice",
          choice: "game_server",
          probabilities: { game_server: 0.93, always_on: 0.04 },
          confidence: o.useCaseConfidence ?? 0.93,
        },
        plan: {
          type: "choice",
          choice: "game-small",
          probabilities: { "game-small": 0.88, "vm-medium": 0.1 },
          confidence: 0.88,
        },
        recipe: {
          type: "choice",
          choice: "minecraft_java",
          probabilities: { minecraft_java: 0.9, minecraft_bedrock: 0.08 },
          confidence: 0.9,
        },
        wants_gui: { type: "noul", noul: 0.02 },
        players_connect: { type: "noul", noul: 0.95 },
        abuse: { type: "noul", noul: 0.01 },
        is_english: { type: "noul", noul: o.isEnglish ?? 0.99 },
      },
      usage: { input_tokens: 812, output_tokens: 9, cost: o.cost ?? 0.0000312 },
    },
  };
}

function chatReply(content: string): Reply {
  return {
    status: 200,
    body: {
      id: `gen-${randomUUID()}`,
      model: "deepseek/deepseek-v4.1-flash",
      choices: [{ message: { role: "assistant", content } }],
      usage: {
        prompt_tokens: 61,
        completion_tokens: 12,
        cost: 0.000011,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    },
  };
}

// Opt-in real Postgres coverage. Each run owns a fresh schema, never the demo tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("concierge suggest", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let db: Database;
  const apiKey = `sk-test-${randomUUID()}`;

  function config(
    fetch: typeof globalThis.fetch,
    o: Partial<ConciergeConfig> = {},
  ): ConciergeConfig {
    return { apiKey, dailyCap: 30, fetch, now: () => new Date(), ...o };
  }

  function run(
    input: { user: PortalUser; text: string },
    cfg: ConciergeConfig,
  ) {
    return Effect.runPromise(
      suggest(input).pipe(
        Effect.either,
        Effect.provideService(ConciergeConfigTag, cfg),
        Effect.provide(DatabaseLive(db)),
      ),
    );
  }

  async function succeeds(
    input: { user: PortalUser; text: string },
    cfg: ConciergeConfig,
  ): Promise<Suggestion> {
    const result = await run(input, cfg);
    if (Either.isLeft(result)) throw new Error(`failed: ${result.left._tag}`);
    return result.right;
  }

  async function fails(
    input: { user: PortalUser; text: string },
    cfg: ConciergeConfig,
  ) {
    const result = await run(input, cfg);
    if (Either.isRight(result)) throw new Error("expected a failure");
    return result.left;
  }

  async function newUser(
    tier: "technical" | "nontechnical" = "nontechnical",
  ): Promise<PortalUser> {
    const id = randomUUID();
    await client`INSERT INTO users (id, name, role, tier, account_status)
                 VALUES (${id}, ${id}, 'member', ${tier}, 'approved')`;
    return { id, name: id, role: "member", tier, email: null };
  }

  const runsOf = (userId: string) =>
    client`SELECT * FROM agent_runs WHERE user_id = ${userId} ORDER BY started_at`;
  const callsOf = (userId: string) =>
    client`SELECT * FROM llm_calls WHERE user_id = ${userId} ORDER BY created_at, id`;

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
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });

  test("one Jev call ledgers one run and one call at the reported cost", async () => {
    const user = await newUser();
    const t = fakeTransport([jevReply({ cost: 0.0000312 })]);
    const suggestion = await succeeds(
      { user, text: "vanilla minecraft for me and 4 friends" },
      config(t.fetch),
    );
    expect(suggestion).toMatchObject({
      outcome: "suggested",
      useCase: "game_server",
      planId: "game-small",
      recipeId: "minecraft_java",
      warnings: ["players_need_ipv6"],
      translated: false,
      model: JEV_MODEL_REPORTED,
    });

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(t.calls[0]!.authorization).toBe(`Bearer ${apiKey}`);
    const runs = await runsOf(user.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: "concierge",
      purpose: "prod",
      status: "succeeded",
    });
    expect(runs[0]!.finished_at).not.toBeNull();
    const calls = await callsOf(user.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agent_run_id: runs[0]!.id,
      provider: "openrouter",
      model: JEV_MODEL_REPORTED,
      input_tokens: 812,
      output_tokens: 9,
      status: "ok",
      price_table_version: "openrouter-usage-cost",
    });
    // ceil(31.2) micro-dollars; bigint column comes back as a decimal string.
    expect(String(calls[0]!.cost_micro_usd)).toBe("32");
    expect(calls[0]!.prompt_hash).toBe(
      createHash("sha256").update(t.calls[0]!.body).digest("hex"),
    );
  });

  test("micro-dollar rounding ignores float noise on exact amounts", async () => {
    const user = await newUser();
    const t = fakeTransport([jevReply({ cost: 0.000031 })]);
    await run({ user, text: "a bot that runs 24/7" }, config(t.fetch));
    const calls = await callsOf(user.id);
    expect(String(calls[0]!.cost_micro_usd)).toBe("31");
  });

  test("unsure non-English text is translated once and re-asked", async () => {
    const user = await newUser();
    const english = "I want an Ubuntu desktop in my browser";
    const t = fakeTransport([
      jevReply({ isEnglish: 0.01, useCaseConfidence: 0.41 }),
      chatReply(english),
      jevReply({ isEnglish: 0.99 }),
    ]);
    const result = await succeeds(
      { user, text: "Je veux un bureau Ubuntu dans mon navigateur" },
      config(t.fetch),
    );
    expect(result.translated).toBe(true);
    expect(t.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/alpha/decisions",
      "/api/v1/chat/completions",
      "/api/alpha/decisions",
    ]);
    const chat = JSON.parse(t.calls[1]!.body);
    expect(chat.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(chat.temperature).toBe(0);
    expect(JSON.parse(t.calls[2]!.body).state.request).toBe(english);

    const runs = await runsOf(user.id);
    expect(runs).toHaveLength(1);
    const calls = await callsOf(user.id);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.agent_run_id === runs[0]!.id)).toBe(true);
    const translation = calls.find(
      (c) => c.model === "deepseek/deepseek-v4.1-flash",
    )!;
    expect(translation).toMatchObject({
      input_tokens: 61,
      output_tokens: 12,
      cached_input_tokens: 20,
      status: "ok",
    });
    expect(String(translation.cost_micro_usd)).toBe("11");
  });

  test("confident non-English text is not translated", async () => {
    const user = await newUser();
    const t = fakeTransport([jevReply({ isEnglish: 0.01 })]);
    const result = await succeeds(
      { user, text: "minecraft para mí y mis amigos" },
      config(t.fetch),
    );
    expect(result.translated).toBe(false);
    expect(t.calls).toHaveLength(1);
  });

  test("the daily cap refuses the call after the cap and resets at UTC midnight", async () => {
    const user = await newUser();
    const t = fakeTransport([jevReply(), jevReply(), jevReply()]);
    const cfg = config(t.fetch, { dailyCap: 2 });
    for (let i = 0; i < 2; i++) {
      await succeeds({ user, text: "a bot" }, cfg);
    }
    expect(await fails({ user, text: "a bot" }, cfg)).toBeInstanceOf(
      ConciergeCapReached,
    );
    expect(await runsOf(user.id)).toHaveLength(2);
    expect(t.calls).toHaveLength(2);

    const tomorrow = new Date(Date.now() + DAY_MS);
    const next = await succeeds(
      { user, text: "a bot" },
      config(t.fetch, { dailyCap: 2, now: () => tomorrow }),
    );
    expect(next.outcome).toBe("suggested");
  });

  test("an upstream 500 fails the run and ledgers an error call", async () => {
    const user = await newUser();
    const t = fakeTransport([
      { status: 500, body: { error: `provider detail ${apiKey}` } },
    ]);
    const error = await fails({ user, text: "a website" }, config(t.fetch));
    expect(error).toBeInstanceOf(ConciergeUpstream);
    expect(error).toMatchObject({ code: "http_500" });
    expect(JSON.stringify(error)).not.toContain(apiKey);
    const runs = await runsOf(user.id);
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(runs[0]!.finished_at).not.toBeNull();
    const calls = await callsOf(user.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "error", error_code: "http_500" });
    expect(String(calls[0]!.cost_micro_usd)).toBe("0");
  });

  test("a hung provider times out and a malformed answer is rejected", async () => {
    const user = await newUser();
    const hung = fakeTransport(["hang"]);
    const timedOut = await fails(
      { user, text: "a website" },
      config(hung.fetch, { timeoutMs: 50 }),
    );
    expect(timedOut).toMatchObject({
      _tag: "ConciergeUpstream",
      code: "timeout",
    });
    const garbled = fakeTransport([
      { status: 200, body: { answers: { use_case: "yes" } } },
    ]);
    const bad = await fails({ user, text: "a website" }, config(garbled.fetch));
    expect(bad).toMatchObject({
      _tag: "ConciergeUpstream",
      code: "bad_response",
    });
    const runs = await runsOf(user.id);
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  test("the user's text never reaches the database", async () => {
    const user = await newUser();
    const marker = `zyx-${randomUUID()}`;
    const englishMarker = `english-${randomUUID()}`;
    const t = fakeTransport([
      jevReply({ isEnglish: 0.01, useCaseConfidence: 0.3 }),
      chatReply(englishMarker),
      jevReply(),
      { status: 502, body: {} },
    ]);
    await run({ user, text: `bureau ${marker}` }, config(t.fetch));
    await run({ user, text: `serveur ${marker}` }, config(t.fetch));
    const dump = JSON.stringify([
      await client`SELECT row_to_json(r) AS j FROM agent_runs r WHERE user_id = ${user.id}`,
      await client`SELECT row_to_json(c) AS j FROM llm_calls c WHERE user_id = ${user.id}`,
      await client`SELECT row_to_json(e) AS j FROM activity_events e`,
    ]);
    expect(dump).toContain(user.id);
    expect(dump).not.toContain(marker);
    expect(dump).not.toContain(englishMarker);
  });

  describe("POST /api/concierge/suggest", () => {
    let app: FastifyInstance | null = null;

    async function approvedCookie(): Promise<string> {
      const user = await newUser();
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await client`INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES (${tokenHash}, ${user.id}, ${new Date(Date.now() + DAY_MS).toISOString()})`;
      return `hh_session=${token}`;
    }

    async function post(
      concierge: ConciergeConfig | null,
      payload: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      if (app) await app.close();
      app = buildApp({ db, concierge });
      const response = await app.inject({
        method: "POST",
        url: "/api/concierge/suggest",
        headers: { cookie: await approvedCookie() },
        payload: payload as Record<string, unknown>,
      });
      return { status: response.statusCode, body: response.json() };
    }

    afterAll(async () => {
      if (app) await app.close();
    });

    test("serves a schema-valid suggestion", async () => {
      const t = fakeTransport([jevReply()]);
      const res = await post(config(t.fetch), { text: "  minecraft  " });
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("suggested");
      expect(JSON.parse(t.calls[0]!.body).state.request).toBe("minecraft");
    });

    test("maps unavailable, invalid, cap and upstream to stable codes", async () => {
      expect(await post(null, { text: "minecraft" })).toMatchObject({
        status: 503,
        body: { code: "concierge_unavailable" },
      });
      const unused = fakeTransport([]);
      expect(await post(config(unused.fetch), { text: " " })).toMatchObject({
        status: 400,
        body: { code: "invalid" },
      });
      expect(
        await post(config(unused.fetch, { dailyCap: 0 }), { text: "a bot" }),
      ).toMatchObject({ status: 429, body: { code: "concierge_cap" } });
      const failing = fakeTransport([
        { status: 503, body: { error: `upstream said ${apiKey}` } },
      ]);
      const upstream = await post(config(failing.fetch), { text: "a bot" });
      expect(upstream).toMatchObject({
        status: 502,
        body: { code: "concierge_upstream" },
      });
      expect(JSON.stringify(upstream.body)).not.toContain(apiKey);
    });
  });
});
