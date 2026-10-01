import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import type { DashboardResponse, ServerRequest } from "@homehost/shared";

// Opt-in real Postgres coverage. Each run owns a fresh schema, never the demo tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("setup recipes on requests", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let app: FastifyInstance;
  let alice: string;
  let bob: string;
  let operator: string;

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
    app = buildApp({ db: drizzle(client, { schema }) });
    async function login(personaId: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/demo/session",
        payload: { personaId },
      });
      expect(response.statusCode).toBe(200);
      return String(response.headers["set-cookie"]).split(";")[0];
    }
    [alice, bob, operator] = await Promise.all([
      login("alice"),
      login("bob"),
      login("operator"),
    ]);
  });

  afterEach(async () => {
    if (client)
      await client`TRUNCATE provision_jobs, activity_events, server_requests`;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });

  function create(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie },
      payload: { name: "Setup box", ...payload },
    });
  }

  function retry(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/api/requests/${id}/setup/retry`,
      headers: { cookie },
    });
  }

  async function storedSetup(id: string) {
    const rows = await client`
      SELECT recipe_id, setup_status, eula_accepted_at FROM server_requests WHERE id = ${id}
    `;
    return rows[0] as {
      recipe_id: string | null;
      setup_status: string;
      eula_accepted_at: string | Date | null;
    };
  }

  test("recipes the plan or catalog can't honour are rejected before anything is stored", async () => {
    const refused: Record<string, unknown>[] = [
      { planId: "container-small", recipeId: "minecraft_java" },
      {
        planId: "container-small",
        recipeId: "minecraft_java",
        eulaAccepted: false,
      },
      { planId: "container-small", recipeId: "valheim" },
      { planId: "container-small", recipeId: "code_server" },
      { planId: "container-small", recipeId: "minecraft_bedrock" },
      { planId: "container-small", recipeId: "minecraft" },
      {
        planId: "container-small",
        recipeId: "minecraft_java",
        eulaAccepted: "yes",
      },
    ];
    for (const payload of refused) {
      const response = await create(alice, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe("invalid");
    }
    const [{ count }] =
      await client`SELECT count(*)::int AS count FROM server_requests`;
    expect(count).toBe(0);
  });

  test("an accepted Minecraft request stores the recipe, a pending setup and the EULA time", async () => {
    const before = Date.now();
    const response = await create(alice, {
      planId: "container-small",
      recipeId: "minecraft_java",
      eulaAccepted: true,
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<ServerRequest>();
    expect(created.recipeId).toBe("minecraft_java");
    expect(created.setupStatus).toBe("pending");
    expect(created.setupStep).toBeNull();
    expect(created.setupError).toBeNull();
    expect(created.gameAddress).toBeNull();
    const stored = await storedSetup(created.id);
    expect(stored.eula_accepted_at).not.toBeNull();
    expect(new Date(stored.eula_accepted_at!).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  test("plain requests have no setup and no EULA record", async () => {
    for (const extra of [
      {},
      { recipeId: "none" },
      { recipeId: "none", eulaAccepted: true },
    ]) {
      const response = await create(alice, {
        planId: "container-small",
        ...extra,
      });
      expect(response.statusCode).toBe(201);
      const created = response.json<ServerRequest>();
      expect(created.recipeId).toBeNull();
      expect(created.setupStatus).toBe("none");
      expect(created.gameAddress).toBeNull();
      const stored = await storedSetup(created.id);
      expect(stored.recipe_id).toBeNull();
      expect(stored.eula_accepted_at).toBeNull();
      await client`TRUNCATE provision_jobs, activity_events, server_requests`;
    }
  });

  test("license-free recipes never record a EULA", async () => {
    const node = await create(alice, {
      planId: "container-small",
      recipeId: "node",
      eulaAccepted: true,
    });
    expect(node.statusCode).toBe(201);
    expect(node.json<ServerRequest>().setupStatus).toBe("pending");
    expect(
      (await storedSetup(node.json<ServerRequest>().id)).eula_accepted_at,
    ).toBeNull();
    const docker = await create(bob, {
      planId: "vm-medium",
      recipeId: "docker",
    });
    expect(docker.statusCode).toBe(201);
    expect(docker.json<ServerRequest>().recipeId).toBe("docker");
    expect(docker.json<ServerRequest>().setupStatus).toBe("pending");
  });

  test("a nontechnical account can request Docker on a container", async () => {
    const response = await create(alice, {
      planId: "container-small",
      recipeId: "docker",
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<ServerRequest>();
    expect(created).toMatchObject({
      planId: "container-small",
      recipeId: "docker",
      setupStatus: "pending",
    });
    expect((await storedSetup(created.id)).eula_accepted_at).toBeNull();
  });

  test("players get the hostname only once a game recipe finished setup", async () => {
    const created = (
      await create(alice, {
        planId: "container-small",
        recipeId: "minecraft_java",
        eulaAccepted: true,
      })
    ).json<ServerRequest>();
    await client`
      UPDATE server_requests SET status = 'running', setup_status = 'done', setup_step = 'wait_ready'
      WHERE id = ${created.id}
    `;
    const dashboard = (
      await app.inject({ url: "/api/dashboard", headers: { cookie: alice } })
    ).json<DashboardResponse>();
    const listed = dashboard.requests.find((r) => r.id === created.id)!;
    expect(listed.setupStatus).toBe("done");
    expect(listed.setupStep).toBe("wait_ready");
    expect(listed.gameAddress).toBe(created.subdomain);
  });

  test("setup retry: owner only, failed+running only, enqueues exactly one setup job", async () => {
    const created = (
      await create(alice, {
        planId: "container-small",
        recipeId: "minecraft_java",
        eulaAccepted: true,
      })
    ).json<ServerRequest>();
    const id = created.id;

    // Not failed yet (pending, then running+done): nothing to retry.
    expect((await retry(alice, id)).statusCode).toBe(409);
    await client`UPDATE server_requests SET status = 'running', setup_status = 'done' WHERE id = ${id}`;
    expect((await retry(alice, id)).statusCode).toBe(409);
    // Failed, but the box is stopped: retry waits for it to run again.
    await client`
      UPDATE server_requests
      SET status = 'stopped', setup_status = 'failed', setup_step = 'download_minecraft', setup_error = 'download_failed'
      WHERE id = ${id}
    `;
    expect((await retry(alice, id)).statusCode).toBe(409);
    await client`UPDATE server_requests SET status = 'running' WHERE id = ${id}`;

    // Other tenants and the operator see no such request.
    expect((await retry(bob, id)).statusCode).toBe(404);
    expect((await retry(operator, id)).statusCode).toBe(404);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => retry(alice, id)),
    );
    const ok = attempts.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(4);
    const retried = ok[0]!.json<ServerRequest>();
    expect(retried.setupStatus).toBe("pending");
    expect(retried.setupStep).toBeNull();
    expect(retried.setupError).toBeNull();
    const jobs = await client`
      SELECT action, status FROM provision_jobs WHERE request_id = ${id}
    `;
    expect(jobs).toEqual([{ action: "setup", status: "queued" }]);

    // A later failure while the first job is still queued cannot stack a second.
    await client`UPDATE server_requests SET setup_status = 'failed', setup_error = 'not_ready' WHERE id = ${id}`;
    expect((await retry(alice, id)).statusCode).toBe(409);
    expect(
      (await client`SELECT 1 FROM provision_jobs WHERE request_id = ${id}`)
        .length,
    ).toBe(1);
  });

  test("a plain request never has a setup to retry", async () => {
    const created = (
      await create(alice, { planId: "container-small" })
    ).json<ServerRequest>();
    await client`UPDATE server_requests SET status = 'running' WHERE id = ${created.id}`;
    expect((await retry(alice, created.id)).statusCode).toBe(409);
  });
});
