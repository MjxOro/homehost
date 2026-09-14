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
describe.skipIf(!databaseUrl)("request lifecycle transactions", () => {
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
    // Apply every checked-in migration in order so the scratch schema always
    // matches the Drizzle schema, including provision_jobs and new columns.
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

  test("simultaneous reservations respect quota; cancellation retains exactly one audit event", async () => {
    const requests = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/api/requests",
          headers: { cookie: alice },
          payload: { name: `Race ${i}`, planId: "game-small" },
        }),
      ),
    );
    expect(requests.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(requests.filter((r) => r.statusCode === 429)).toHaveLength(7);
    const created = requests
      .find((r) => r.statusCode === 201)!
      .json<ServerRequest>();
    const deletions = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: "DELETE",
          url: `/api/requests/${created.id}`,
          headers: { cookie: alice },
        }),
      ),
    );
    expect(deletions.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(deletions.filter((r) => r.statusCode === 404)).toHaveLength(5);
    const dashboard = (
      await app.inject({ url: "/api/dashboard", headers: { cookie: alice } })
    ).json<DashboardResponse>();
    expect(dashboard.usage.servers).toBe(0);
    expect(dashboard.requests.some((r) => r.id === created.id)).toBe(false);
    expect(
      dashboard.activity.filter(
        (e) => e.requestId === created.id && e.action === "deleted",
      ),
    ).toHaveLength(1);
  });

  test("tenant and operator authority cannot be supplied by request fields", async () => {
    const spoof = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: alice },
      payload: {
        name: "Spoof",
        planId: "game-small",
        ownerId: "bob",
        trusted: true,
      },
    });
    expect(spoof.statusCode).toBe(400);
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: alice },
      payload: {
        name: "Tenant boundary",
        planId: "game-small",
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<ServerRequest>();
    for (const cookie of [bob, operator]) {
      const dashboard = (
        await app.inject({ url: "/api/dashboard", headers: { cookie } })
      ).json<DashboardResponse>();
      expect(dashboard.requests.some((r) => r.id === created.id)).toBe(false);
      expect(dashboard.activity.some((e) => e.requestId === created.id)).toBe(
        false,
      );
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/requests/${created.id}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/requests/${created.id}/decision`,
          headers: { cookie: alice },
          payload: { decision: "approve" },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: "DELETE",
      url: `/api/requests/${created.id}`,
      headers: { cookie: alice },
    });
  });

  test("denied cross-origin logout leaves the session and cookie intact", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie: alice, origin: "http://127.0.0.1:9999" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    const session = await app.inject({
      url: "/api/session",
      headers: { cookie: alice },
    });
    expect(session.json().user.id).toBe("alice");
  });

  test("competing operator decisions cannot overwrite a completed transition", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: alice },
      payload: { name: "Decision race", planId: "game-small" },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<ServerRequest>();
    const decisions = await Promise.all(
      ["approve", "reject"].map((decision) =>
        app.inject({
          method: "POST",
          url: `/api/requests/${created.id}/decision`,
          headers: { cookie: operator },
          payload: { decision },
        }),
      ),
    );
    expect(decisions.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = decisions
      .find((r) => r.statusCode === 200)!
      .json<ServerRequest>();
    const dashboard = (
      await app.inject({ url: "/api/dashboard", headers: { cookie: alice } })
    ).json<DashboardResponse>();
    expect(dashboard.requests.find((r) => r.id === created.id)?.status).toBe(
      winner.status,
    );
    expect(dashboard.usage.servers).toBe(winner.status === "approved" ? 1 : 0);
    expect(
      dashboard.activity.filter(
        (e) =>
          e.requestId === created.id &&
          (e.action === "approved" || e.action === "rejected"),
      ),
    ).toHaveLength(1);
    await app.inject({
      method: "DELETE",
      url: `/api/requests/${created.id}`,
      headers: { cookie: alice },
    });
  });

  test("aggregate resources and released rejections drive later admission", async () => {
    // Technical quota (3 servers, 8 cpu, 8192 MB): two vm-mediums fill cpu
    // and memory exactly; the third must fail on aggregates, not count.
    const trustedAttempts = await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/api/requests",
          headers: { cookie: bob },
          payload: { name: `Trusted ${i}`, planId: "vm-medium" },
        }),
      ),
    );
    expect(
      trustedAttempts.every((response) => response.statusCode === 201),
    ).toBe(true);
    const overAggregateQuota = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: bob },
      payload: { name: "Trusted overflow", planId: "vm-medium" },
    });
    expect(overAggregateQuota.statusCode).toBe(429);

    const first = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: alice },
      payload: { name: "Rejected slot", planId: "game-small" },
    });
    expect(first.statusCode).toBe(201);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/requests/${first.json<ServerRequest>().id}/decision`,
      headers: { cookie: operator },
      payload: { decision: "reject" },
    });
    expect(rejected.statusCode).toBe(200);
    const replacement = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: alice },
      payload: { name: "Replacement slot", planId: "game-small" },
    });
    expect(replacement.statusCode).toBe(201);
  });

  test("ssh key persists at create; instance password reads exactly once", async () => {
    const key =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcfXKn/5G39jJ5beNyDe3WnorXY9oa5Cu2Cif8x5gWI alice@kitchen";
    const keyed = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: bob },
      payload: { name: "Keyed box", planId: "vm-medium", sshPubkey: key },
    });
    expect(keyed.statusCode).toBe(201);
    expect(keyed.json<ServerRequest>().hasSshKey).toBe(true);
    const unkeyed = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: bob },
      payload: { name: "Plain box", planId: "game-small" },
    });
    expect(unkeyed.json<ServerRequest>().hasSshKey).toBe(false);
    const bogus = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: bob },
      payload: {
        name: "Bogus key",
        planId: "vm-medium",
        sshPubkey: "not-a-key",
      },
    });
    expect(bogus.statusCode).toBe(400);
    const containerKey = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: bob },
      payload: { name: "Container key", planId: "game-small", sshPubkey: key },
    });
    expect(containerKey.statusCode).toBe(201);
    expect(containerKey.json<ServerRequest>().hasSshKey).toBe(true);
    // The worker mints the secret at launch; seed a random stand-in here so
    // no password-shaped literal ever lives in the repo.
    const fixturePassword = randomUUID();
    const id = keyed.json<ServerRequest>().id;
    await client`UPDATE server_requests SET instance_password = ${fixturePassword} WHERE id = ${id}`;
    const foreign = await app.inject({
      method: "GET",
      url: `/api/requests/${id}/credentials`,
      headers: { cookie: alice },
    });
    expect(foreign.statusCode).toBe(404);
    const first = await app.inject({
      method: "GET",
      url: `/api/requests/${id}/credentials`,
      headers: { cookie: operator },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ password: string | null }>().password).toBe(
      fixturePassword,
    );
    const second = await app.inject({
      method: "GET",
      url: `/api/requests/${id}/credentials`,
      headers: { cookie: bob },
    });
    expect(second.statusCode).toBe(200);
    await client`UPDATE server_requests SET ssh_port = 22000 WHERE id = ${id}`;
    const leased = (
      await app.inject({ url: "/api/dashboard", headers: { cookie: bob } })
    ).json<DashboardResponse>();
    // v6-only contract: stale port values never surface to clients.
    expect(leased.requests.find((r) => r.id === id)?.sshPort).toBeUndefined();
  });
});
