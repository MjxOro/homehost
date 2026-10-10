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
import { Effect, Either } from "effect";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import { DatabaseLive } from "../src/domain/Database.js";
import { lookupAddress } from "../src/domain/ipAssignments.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("IP assignment history", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  const address = "2001:db8:abcd::a";
  const start = "2026-10-02T14:00:00.000Z";
  const end = "2026-10-02T15:00:00.000Z";
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let app: FastifyInstance;
  let operator: string;
  let member: string;
  let fixtureIds: string[] = [];
  let migration: string;

  async function login(personaId: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      payload: { personaId },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0]!;
  }

  async function fixture(status = "running", ipv6: string | null = null) {
    const userId = randomUUID();
    const requestId = randomUUID();
    const ownerName = `Owner ${userId.slice(0, 8)}`;
    const ownerEmail = `${userId}@example.test`;
    const subdomain = `ip-${requestId}.lab.example.test`;
    fixtureIds.push(userId);
    await client`INSERT INTO users (id, name, email, role, tier)
      VALUES (${userId}, ${ownerName}, ${ownerEmail}, 'member', 'nontechnical')`;
    await client`INSERT INTO server_requests
      (id, owner_id, owner_name, name, plan_id, status, subdomain, cpu, memory_mb, disk_gb, ipv6, created_at, updated_at)
      VALUES (${requestId}, ${userId}, ${ownerName}, 'History fixture', 'container-small', ${status},
        ${subdomain}, 1, 512, 10, ${ipv6}, ${start}, ${end})`;
    return { userId, requestId, ownerName, ownerEmail, subdomain };
  }

  async function assign(
    owner: Awaited<ReturnType<typeof fixture>>,
    assignedAt = start,
    releasedAt: string | null = null,
    ip = address,
  ) {
    const rows = await client`INSERT INTO ip_assignments
      (request_id, user_id, owner_name, owner_email, address, subdomain, prefix, assigned_at, released_at)
      VALUES (${owner.requestId}, ${owner.userId}, ${owner.ownerName}, ${owner.ownerEmail}, ${ip}::inet,
        ${owner.subdomain}, network(set_masklen(${ip}::inet, 64))::text, ${assignedAt}, ${releasedAt}) RETURNING id`;
    return String(rows[0]!.id);
  }

  function lookup(ip = address, at?: string | Date) {
    return Effect.runPromise(
      lookupAddress(ip, at).pipe(
        Effect.provide(DatabaseLive(drizzle(client, { schema }))),
      ),
    );
  }

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    client = postgres(databaseUrl!, {
      connection: { search_path: namespace },
      max: 8,
    });
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      const source = await readFile(new URL(file, dir), "utf8");
      await client.unsafe(source);
      if (file === "0013_ip_assignments.sql") migration = source;
    }
    app = buildApp({ db: drizzle(client, { schema }) });
    [operator, member] = await Promise.all([login("operator"), login("alice")]);
  });

  afterEach(async () => {
    if (!client) return;
    await client`TRUNCATE agent_messages, agent_conversations, ip_assignments, provision_jobs, activity_events, server_requests`;
    if (fixtureIds.length)
      await client`DELETE FROM users WHERE id = ANY(${fixtureIds})`;
    fixtureIds = [];
  });

  afterAll(async () => {
    if (app) await app.close();
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });

  test("lookup covers the inclusive start and excludes release and later instants", async () => {
    const owner = await fixture();
    await assign(owner, start, end);
    expect(await lookup(address, "2026-10-02T13:59:59Z")).toEqual([]);
    expect((await lookup(address, start))[0]?.ownerEmail).toBe(
      owner.ownerEmail,
    );
    expect((await lookup(address, "2026-10-02T14:03:00Z"))[0]?.userId).toBe(
      owner.userId,
    );
    expect(await lookup(address, end)).toEqual([]);
    expect(await lookup(address, "2026-10-02T16:00:00Z")).toEqual([]);
  });

  test("reassigned address resolves the correct owner on each side of the boundary", async () => {
    const first = await fixture();
    const second = await fixture();
    await assign(first, start, end);
    await assign(second, end);
    expect((await lookup(address, start))[0]?.userId).toBe(first.userId);
    expect((await lookup(address, end))[0]?.userId).toBe(second.userId);
    expect((await lookup(address, "2030-01-01T00:00:00Z"))[0]?.userId).toBe(
      second.userId,
    );
  });

  test("lookup preserves microsecond precision at a release boundary", async () => {
    const owner = await fixture();
    const boundary = "2026-10-02T14:03:00.000400Z";
    await assign(owner, start, boundary);
    expect(
      (await lookup(address, "2026-10-02T14:03:00.000399Z"))[0]?.userId,
    ).toBe(owner.userId);
    expect(await lookup(address, boundary)).toEqual([]);
  });

  test("database rejects two open assignments for equivalent addresses", async () => {
    await assign(await fixture());
    await expect(
      assign(
        await fixture(),
        start,
        null,
        "2001:0DB8:ABCD:0000:0000:0000:0000:000A",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("database rejects inverted windows and network masks", async () => {
    const owner = await fixture();
    await expect(assign(owner, end, start)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      assign(owner, start, null, "2001:db8:abcd::/64"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("compressed, expanded, uppercase and full host masks normalize identically", async () => {
    const id = await assign(await fixture());
    for (const ip of [
      address,
      "2001:0DB8:ABCD:0000:0000:0000:0000:000A",
      `${address}/128`,
    ]) {
      expect((await lookup(ip))[0]?.id).toBe(id);
      expect((await lookup(ip))[0]?.address).toBe(address);
    }
  });

  test("IPv4-mapped IPv6 dotted and hexadecimal forms normalize identically", async () => {
    const id = await assign(await fixture(), start, null, "::ffff:192.0.2.1");
    expect((await lookup("0:0:0:0:0:FFFF:C000:0201"))[0]?.id).toBe(id);
    expect((await lookup("::ffff:192.0.2.1"))[0]?.id).toBe(id);
    expect(await lookup("192.0.2.1")).toEqual([]);
  });

  test("invalid address produces a typed error even with an empty ledger", async () => {
    for (const ip of ["not-an-ip", "", "2001:db8::/64", "300.1.1.1"]) {
      const result = await Effect.runPromise(
        Effect.either(lookupAddress(ip)).pipe(
          Effect.provide(DatabaseLive(drizzle(client, { schema }))),
        ),
      );
      expect(Either.isLeft(result) && result.left._tag).toBe("InvalidAddress");
    }
  });

  test("invalid lookup time produces a typed error", async () => {
    const result = await Effect.runPromise(
      Effect.either(lookupAddress(address, "not-a-time")).pipe(
        Effect.provide(DatabaseLive(drizzle(client, { schema }))),
      ),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("InvalidLookupTime");
  });

  test("no instant returns the open assignment plus only twenty most recent closed ones", async () => {
    const owner = await fixture();
    const ids: string[] = [];
    for (let hour = 0; hour < 25; hour++) {
      ids.push(
        await assign(
          owner,
          new Date(Date.UTC(2026, 9, 1, hour)).toISOString(),
          new Date(Date.UTC(2026, 9, 1, hour + 1)).toISOString(),
        ),
      );
    }
    const openId = await assign(owner, end);
    const rows = await lookup();
    expect(rows.map((row) => row.id)).toEqual([
      openId,
      ...ids.slice(-20).reverse(),
    ]);
  });

  test("snapshots survive account changes and physical request/user deletion via LEFT JOIN", async () => {
    const owner = await fixture();
    await assign(owner);
    await client`UPDATE users SET name = 'Changed', email = ${`${randomUUID()}@example.test`} WHERE id = ${owner.userId}`;
    expect((await lookup())[0]?.ownerEmail).toBe(owner.ownerEmail);
    await client`DELETE FROM server_requests WHERE id = ${owner.requestId}`;
    await client`DELETE FROM users WHERE id = ${owner.userId}`;
    const row = (await lookup())[0]!;
    expect(row.ownerName).toBe(owner.ownerName);
    expect(row.ownerEmail).toBe(owner.ownerEmail);
    expect(row.subdomain).toBe(owner.subdomain);
    expect(row.requestSubdomain).toBeNull();
  });

  test("history does not block live-table truncation and has no foreign keys", async () => {
    const owner = await fixture();
    await assign(owner);
    await client`TRUNCATE agent_messages, agent_conversations, provision_jobs, activity_events, server_requests`;
    expect((await lookup())[0]?.userId).toBe(owner.userId);
    const keys =
      await client`SELECT 1 FROM pg_constraint WHERE conrelid = 'ip_assignments'::regclass AND contype = 'f'`;
    expect(keys).toHaveLength(0);
  });

  test("backfill covers active/deleted only, uses running or creation time, and is idempotent", async () => {
    const active = await fixture("running", address);
    const deleted = await fixture("deleted", "2001:db8:abcd::b");
    await fixture("rejected", "2001:db8:abcd::c");
    await fixture("approved");
    const running = "2026-10-02T14:02:00.000Z";
    await client`INSERT INTO activity_events (request_id, actor_name, action, server_name, created_at)
      VALUES (${active.requestId}, 'Worker', 'running', 'History fixture', ${running})`;
    await client.unsafe(migration);
    await client.unsafe(migration);
    const rows =
      await client`SELECT request_id, owner_email, prefix, assigned_at, released_at FROM ip_assignments ORDER BY released_at NULLS FIRST`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.request_id).toBe(active.requestId);
    expect(rows[0]!.owner_email).toBe(active.ownerEmail);
    expect(rows[0]!.prefix).toBe("2001:db8:abcd::/64");
    expect(new Date(rows[0]!.assigned_at).toISOString()).toBe(running);
    expect(rows[0]!.released_at).toBeNull();
    expect(rows[1]!.request_id).toBe(deleted.requestId);
    expect(new Date(rows[1]!.assigned_at).toISOString()).toBe(start);
    expect(new Date(rows[1]!.released_at).toISOString()).toBe(end);
    await client`UPDATE ip_assignments SET released_at = ${end} WHERE request_id = ${active.requestId}`;
    await client.unsafe(migration);
    expect((await lookup())[0]?.releasedAt).not.toBeNull();
    expect(await client`SELECT id FROM ip_assignments`).toHaveLength(2);
  });

  test("operator route serializes snapshots and supports ISO offset instants", async () => {
    const owner = await fixture();
    await assign(owner, start, end);
    const query = new URLSearchParams({
      address,
      at: "2026-10-02T16:03:00+02:00",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/ip-lookup?${query}`,
      headers: { cookie: operator },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().assignments[0]).toMatchObject({
      userId: owner.userId,
      ownerEmail: owner.ownerEmail,
      assignedAt: start,
      releasedAt: end,
      requestSubdomain: owner.subdomain,
    });
  });

  test("operator route rejects missing/malformed address and invalid ISO time", async () => {
    for (const query of [
      "",
      "address=bad-ip",
      `address=${address}&at=invalid`,
      `address=${address}&at=2026-10-02`,
      `address=${address}&unexpected=yes`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/admin/ip-lookup?${query}`,
        headers: { cookie: operator },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("invalid");
    }
  });

  test("member is forbidden and anonymous caller is unauthenticated", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/ip-lookup?address=${address}`,
          headers: { cookie: member },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/ip-lookup?address=${address}`,
        })
      ).statusCode,
    ).toBe(401);
  });

  test("backfill skips malformed ipv6 text instead of aborting the migration", async () => {
    await fixture("running", "not-an-ip");
    await fixture("running", "2001:db8:abcd::a/64");
    await client.unsafe(migration);
    expect(await client`SELECT id FROM ip_assignments`).toHaveLength(0);
  });
});
