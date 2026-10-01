import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import {
  SECRET_GUARD_COPY,
  SECRET_PLACEHOLDER,
  type AgentConversation,
  type ServerRequest,
} from "@homehost/shared";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import type { Database } from "../src/db/client.js";
import { AGENT_MODEL, type AgentChatConfig } from "../src/domain/agent-chat.js";

type Reply = { status: number; body: unknown };
function transport(replies: Reply[]) {
  const calls: Record<string, unknown>[] = [];
  const fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected call");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
function completion(
  tool?: { name: string; args: unknown },
  text = "Here's a server setup. Click Create it when you're ready.",
): Reply {
  return {
    status: 200,
    body: {
      id: randomUUID(),
      model: AGENT_MODEL,
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0000012 },
      choices: [
        {
          finish_reason: tool ? "tool_calls" : "stop",
          message: tool
            ? {
                content: null,
                tool_calls: [
                  {
                    id: randomUUID(),
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(tool.args),
                    },
                  },
                ],
              }
            : { content: text },
        },
      ],
    },
  };
}
function jev(): Reply {
  const choice = (id: string) => ({
    choice: id,
    probabilities: { [id]: 0.95 },
    confidence: 0.95,
  });
  return {
    status: 200,
    body: {
      id: randomUUID(),
      model: "typesafe/jev-1.13",
      usage: { input_tokens: 100, output_tokens: 20, cost: 0.00003 },
      answers: {
        use_case: choice("always_on"),
        plan: choice("container-small"),
        recipe: choice("node"),
        wants_gui: { noul: 0.01 },
        console_player: { noul: 0.01 },
        abuse: { noul: 0.01 },
        scraping: { noul: 0.01 },
        is_english: { noul: 0.99 },
      },
    },
  };
}
const setup = { name: "my-bot", planId: "container-small", recipeId: "docker" };
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("agent chat", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let db: Database;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    client = postgres(databaseUrl!, {
      connection: { search_path: namespace },
      max: 10,
    });
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await client.unsafe(await readFile(new URL(file, dir), "utf8"));
    db = drizzle(client, { schema });
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    await client?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });
  async function identity(
    tier = "nontechnical",
    role = "member",
    status = "approved",
  ) {
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    await client`INSERT INTO users (id,name,role,tier,account_status) VALUES (${id}, 'Test member', ${role}, ${tier}, ${status})`;
    await client`INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (${createHash("sha256").update(token).digest("hex")},${id},${new Date(Date.now() + 86400000).toISOString()})`;
    return { id, cookie: `hh_session=${token}` };
  }
  function appFor(t: ReturnType<typeof transport>, cap = 40, enabled = true) {
    const config: AgentChatConfig = {
      apiKey: randomUUID(),
      dailyCap: cap,
      now: () => new Date(),
      fetch: t.fetch,
    };
    const app = buildApp({
      db,
      agentChat: enabled ? config : null,
      concierge: null,
    });
    apps.push(app);
    return app;
  }
  function post(
    app: FastifyInstance,
    cookie: string,
    url: string,
    payload: unknown,
  ) {
    return app.inject({
      method: "POST",
      url,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  }
  async function create(
    app: FastifyInstance,
    cookie: string,
    text = "a discord bot for my server",
  ) {
    const res = await post(app, cookie, "/api/agent/conversations", { text });
    expect(res.statusCode).toBe(201);
    return res.json<AgentConversation>();
  }
  const card = (c: AgentConversation) =>
    c.messages.find((m) => m.toolResult?.proposal)!;

  test("suggest and propose are metered but cannot create until the user clicks; repeated clicks link one request", async () => {
    const t = transport([
      completion({ name: "suggest_setup", args: { text: "a discord bot" } }),
      jev(),
      completion({ name: "propose_server", args: setup }),
      completion(),
    ]);
    const app = appFor(t);
    const user = await identity();
    const initial = await create(app, user.cookie);
    expect(initial.status).toBe("pending");
    expect(initial.messages[0]?.role).toBe("user");
    const turn = await post(
      app,
      user.cookie,
      `/api/agent/conversations/${initial.id}/turns`,
      {},
    );
    expect(turn.statusCode).toBe(200);
    const proposal = card(turn.json<AgentConversation>());
    expect(proposal.toolResult?.proposal).toEqual(setup);
    expect(
      (
        await client`SELECT count(*)::int AS n FROM server_requests WHERE owner_id=${user.id}`
      )[0]!.n,
    ).toBe(0);
    expect(t.calls[0]).toMatchObject({
      model: AGENT_MODEL,
      max_tokens: 2000,
      provider: { data_collection: "deny" },
      reasoning: { effort: "low", exclude: true },
    });
    expect(
      (t.calls[0]!.tools as { function: { name: string } }[]).map(
        (t) => t.function.name,
      ),
    ).toEqual([
      "suggest_setup",
      "propose_server",
      "server_status",
      "list_my_servers",
    ]);
    const [run] =
      await client`SELECT * FROM agent_runs WHERE user_id=${user.id}`;
    expect(run!.kind).toBe("agent_chat");
    expect(run!.status).toBe("succeeded");
    const [usage] =
      await client`SELECT count(*)::int AS n, sum(cost_micro_usd)::int AS cost FROM llm_calls WHERE agent_run_id=${run!.id}`;
    expect(usage).toMatchObject({ n: 4, cost: 36 });
    const payload = { ...setup, agentProposalId: proposal.id };
    const created = await post(app, user.cookie, "/api/requests", payload);
    expect(created.statusCode).toBe(201);
    const request = created.json<ServerRequest>();
    const again = await post(app, user.cookie, "/api/requests", payload);
    expect(again.statusCode).toBe(201);
    expect(again.json<ServerRequest>().id).toBe(request.id);
    expect(
      (
        await client`SELECT count(*)::int AS n FROM server_requests WHERE owner_id=${user.id}`
      )[0]!.n,
    ).toBe(1);
    const read = await app.inject({
      url: `/api/agent/conversations/${initial.id}`,
      headers: { cookie: user.cookie },
    });
    expect(read.json<AgentConversation>().settingUp).toBe(true);
    expect(card(read.json<AgentConversation>()).requestId).toBe(request.id);
    // Ready notices are state-derived, idempotent and never call a provider.
    await client`UPDATE server_requests SET status='running',setup_status='done' WHERE id=${request.id}`;
    for (let i = 0; i < 2; i++)
      await app.inject({
        url: `/api/agent/conversations/${initial.id}`,
        headers: { cookie: user.cookie },
      });
    expect(
      (
        await client`SELECT count(*)::int AS n FROM agent_messages WHERE dedupe_key=${`ready:${request.id}`}`
      )[0]!.n,
    ).toBe(1);
    expect(t.calls).toHaveLength(4);
  });

  test("generated secrets never reach storage, titles, provider calls or the meter", async () => {
    const t = transport([]),
      app = appFor(t),
      user = await identity();
    const token = [
      randomBytes(18).toString("base64url"),
      randomBytes(4).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ].join(".");
    const conversation = await create(app, user.cookie, `please use ${token}`);
    expect(conversation.status).toBe("idle");
    expect(conversation.messages.map((m) => m.content)).toEqual([
      SECRET_PLACEHOLDER,
      SECRET_GUARD_COPY,
    ]);
    const guarded = await post(
      app,
      user.cookie,
      `/api/agent/conversations/${conversation.id}/turns`,
      { text: `token: ${token}` },
    );
    expect(guarded.statusCode).toBe(200);
    const dump = JSON.stringify([
      await client`SELECT row_to_json(c) AS j FROM agent_conversations c WHERE user_id=${user.id}`,
      await client`SELECT row_to_json(m) AS j FROM agent_messages m WHERE conversation_id=${conversation.id}`,
    ]);
    expect(dump).not.toContain(token);
    expect(t.calls).toHaveLength(0);
    expect(
      (
        await client`SELECT count(*)::int AS n FROM agent_runs WHERE user_id=${user.id}`
      )[0]!.n,
    ).toBe(0);
  });

  test("conversation, proposal and status tools are owner-only, even for operators", async () => {
    const t = transport([
      completion({ name: "propose_server", args: setup }),
      completion(),
    ]);
    const app = appFor(t),
      a = await identity(),
      b = await identity("technical", "operator");
    const c = await create(app, a.cookie);
    const turn = await post(
      app,
      a.cookie,
      `/api/agent/conversations/${c.id}/turns`,
      {},
    );
    const proposal = card(turn.json<AgentConversation>());
    expect(
      (
        await app.inject({
          url: `/api/agent/conversations/${c.id}`,
          headers: { cookie: b.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(app, b.cookie, `/api/agent/conversations/${c.id}/turns`, {
          text: "hello",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/agent/conversations",
          headers: { cookie: b.cookie },
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await post(app, b.cookie, "/api/requests", {
          ...setup,
          agentProposalId: proposal.id,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(app, a.cookie, "/api/requests", {
          ...setup,
          name: "changed",
          agentProposalId: proposal.id,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("tier and quota gates apply to proposals and the final create", async () => {
    const t = transport([
      completion({
        name: "propose_server",
        args: { ...setup, planId: "vm-medium" },
      }),
      completion(),
      completion({ name: "propose_server", args: setup }),
      completion(),
    ]);
    const app = appFor(t),
      user = await identity(),
      c = await create(app, user.cookie);
    const locked = (
      await post(app, user.cookie, `/api/agent/conversations/${c.id}/turns`, {})
    ).json<AgentConversation>();
    expect(locked.messages.find((m) => m.role === "tool")?.toolResult?.ok).toBe(
      false,
    );
    expect(
      (
        await post(app, user.cookie, "/api/requests", {
          ...setup,
          planId: "vm-medium",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(app, user.cookie, "/api/requests", setup)).statusCode,
    ).toBe(201);
    const full = (
      await post(app, user.cookie, `/api/agent/conversations/${c.id}/turns`, {
        text: "another server",
      })
    ).json<AgentConversation>();
    const lastTool = full.messages.filter((m) => m.role === "tool").at(-1)!;
    expect(lastTool.toolResult?.ok).toBe(false);
    expect(
      (await post(app, user.cookie, "/api/requests", setup)).statusCode,
    ).toBe(429);
    expect(
      (
        await post(app, user.cookie, "/api/requests", {
          ...setup,
          agentProposalId: lastTool.id,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("a proposal does not bypass an intervening quota reservation or EULA acceptance", async () => {
    const t = transport([
      completion({ name: "propose_server", args: setup }),
      completion(),
    ]);
    const app = appFor(t),
      user = await identity(),
      c = await create(app, user.cookie);
    const proposal = card(
      (
        await post(
          app,
          user.cookie,
          `/api/agent/conversations/${c.id}/turns`,
          {},
        )
      ).json<AgentConversation>(),
    );
    await post(app, user.cookie, "/api/requests", setup);
    expect(
      (
        await post(app, user.cookie, "/api/requests", {
          ...setup,
          agentProposalId: proposal.id,
        })
      ).statusCode,
    ).toBe(429);
    const game = { ...setup, recipeId: "minecraft_java" };
    const gameT = transport([
        completion({ name: "propose_server", args: game }),
        completion(),
      ]),
      gameApp = appFor(gameT),
      gameUser = await identity(),
      gameC = await create(gameApp, gameUser.cookie);
    const gameProposal = card(
      (
        await post(
          gameApp,
          gameUser.cookie,
          `/api/agent/conversations/${gameC.id}/turns`,
          {},
        )
      ).json<AgentConversation>(),
    );
    expect(
      (
        await post(gameApp, gameUser.cookie, "/api/requests", {
          ...game,
          agentProposalId: gameProposal.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(gameApp, gameUser.cookie, "/api/requests", {
          ...game,
          agentProposalId: gameProposal.id,
          eulaAccepted: true,
        })
      ).statusCode,
    ).toBe(201);
  });

  test("concurrent turns with one daily slot left admit exactly one", async () => {
    const t = transport([completion(undefined, "Hello!")]),
      app = appFor(t, 1),
      user = await identity();
    const a = await create(app, user.cookie),
      b = await create(app, user.cookie);
    const responses = await Promise.all(
      [a, b].map((c) =>
        post(app, user.cookie, `/api/agent/conversations/${c.id}/turns`, {}),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 429]);
    expect(t.calls).toHaveLength(1);
    expect(
      (
        await client`SELECT count(*)::int AS n FROM agent_runs WHERE user_id=${user.id}`
      )[0]!.n,
    ).toBe(1);
  });

  test("no key returns 503 before storing a conversation; pending accounts cannot use chat", async () => {
    const t = transport([]),
      app = appFor(t, 40, false),
      user = await identity();
    const res = await post(app, user.cookie, "/api/agent/conversations", {
      text: "a bot",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("agent_unavailable");
    expect(
      (
        await client`SELECT count(*)::int AS n FROM agent_conversations WHERE user_id=${user.id}`
      )[0]!.n,
    ).toBe(0);
    const pending = await identity("nontechnical", "member", "pending");
    expect(
      (
        await post(app, pending.cookie, "/api/agent/conversations", {
          text: "a bot",
        })
      ).statusCode,
    ).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  test("unknown creation tools and a seventh tool step cannot create servers", async () => {
    const t = transport(
        Array.from({ length: 7 }, () =>
          completion({ name: "create_server", args: setup }),
        ),
      ),
      app = appFor(t),
      user = await identity(),
      c = await create(app, user.cookie);
    const result = (
      await post(app, user.cookie, `/api/agent/conversations/${c.id}/turns`, {})
    ).json<AgentConversation>();
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(6);
    expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(t.calls.at(-1)!.tools as unknown[]).toEqual([]);
    expect(
      (
        await client`SELECT count(*)::int AS n FROM server_requests WHERE owner_id=${user.id}`
      )[0]!.n,
    ).toBe(0);
  });

  test("foreign server_status results contain no other user's request data", async () => {
    const unused = transport([]),
      app = appFor(unused),
      owner = await identity();
    const request = (
      await post(app, owner.cookie, "/api/requests", setup)
    ).json<ServerRequest>();
    const t = transport([
        completion({ name: "server_status", args: { requestId: request.id } }),
        completion(),
      ]),
      otherApp = appFor(t),
      other = await identity(),
      c = await create(otherApp, other.cookie);
    const result = (
      await post(
        otherApp,
        other.cookie,
        `/api/agent/conversations/${c.id}/turns`,
        {},
      )
    ).json<AgentConversation>();
    expect(
      result.messages.find((m) => m.role === "tool")?.toolResult,
    ).toMatchObject({ ok: false });
    expect(JSON.stringify(t.calls)).not.toContain(request.subdomain);
  });
});
