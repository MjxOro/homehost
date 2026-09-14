import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";

interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
  tier: string;
  accountStatus: string;
  technicalLevel: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

interface AdminListResponse {
  users: AdminUser[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface AuditRow {
  action: string;
  detail: string | null;
  actor_id: string;
  target_user_id: string;
}

interface AdminAction {
  id: string;
  targetUserId: string;
  actorId: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

interface AdminActionsResponse {
  actions: AdminAction[];
  hasMore: boolean;
  nextCursor: string | null;
}

// Opt-in real Postgres coverage. Each run owns a fresh schema, never the demo tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("admin user moderation", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let app: FastifyInstance;
  let alice: string;
  let operator: string;
  let fixtures: string[];

  async function login(personaId: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      payload: { personaId },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0];
  }

  // Fresh member per call: random id/email every run, never a shared literal.
  // Sessions are minted exactly like the app does (64-hex token, sha256 row)
  // so fixture logins exercise the real session resolver.
  async function createFixture(
    status: "pending" | "approved" | "rejected" | "suspended" = "pending",
  ) {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await client`INSERT INTO users (id, name, role, tier, email, account_status)
      VALUES (${id}, ${`Fixture ${id.slice(0, 8)}`}, 'member', 'nontechnical', ${email}, ${status})`;
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await client`INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES (${tokenHash}, ${id}, ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()})`;
    fixtures.push(id);
    return { id, email, cookie: `hh_session=${token}` };
  }

  async function auditFor(userId: string): Promise<AuditRow[]> {
    const rows = (await client`SELECT action, detail, actor_id, target_user_id
      FROM moderation_actions WHERE target_user_id = ${userId}
      ORDER BY created_at ASC, id ASC`) as unknown as AuditRow[];
    return rows;
  }

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    client = postgres(databaseUrl!, {
      connection: { search_path: namespace },
      max: 8,
    });
    // Apply every checked-in migration in order so the scratch schema always
    // matches the Drizzle schema, including user moderation columns.
    const dir = new URL("../migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      await client.unsafe(await readFile(new URL(f, dir), "utf8"));
    }
    fixtures = [];
    app = buildApp({ db: drizzle(client, { schema }) });
    [alice, operator] = await Promise.all([login("alice"), login("operator")]);
  });

  afterEach(async () => {
    if (client) {
      await client`TRUNCATE provision_jobs, activity_events, server_requests, moderation_actions`;
      if (fixtures.length > 0) {
        await client`DELETE FROM users WHERE id = ANY(${fixtures})`;
        fixtures = [];
      }
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });

  test("operator lists pending users; filters and auth boundaries hold", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const pending = await app.inject({
      url: "/api/admin/users?status=pending",
      headers: { cookie: operator },
    });
    expect(pending.statusCode).toBe(200);
    const body = pending.json<AdminListResponse>();
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
    const ids = body.users.map((u) => u.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain("alice");
    for (const user of body.users) {
      expect(user.accountStatus).toBe("pending");
    }
    const approved = (
      await app.inject({
        url: "/api/admin/users?status=approved",
        headers: { cookie: operator },
      })
    ).json<AdminListResponse>();
    expect(approved.users.map((u) => u.id)).toContain("alice");
    expect(approved.users.map((u) => u.id)).not.toContain(first.id);
    const anonymous = await app.inject({ url: "/api/admin/users" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe("unauthorized");
    const member = await app.inject({
      url: "/api/admin/users",
      headers: { cookie: alice },
    });
    expect(member.statusCode).toBe(403);
    expect(member.json().code).toBe("forbidden");
  });

  test("approve sets status, classification, reviewer, and exactly one audit row", async () => {
    const fixture = await createFixture();
    const approved = await app.inject({
      method: "POST",
      url: `/api/admin/users/${fixture.id}/approve`,
      headers: { cookie: operator },
      payload: { technicalLevel: "technical" },
    });
    expect(approved.statusCode).toBe(200);
    const user = approved.json<AdminUser>();
    expect(user.id).toBe(fixture.id);
    expect(user.accountStatus).toBe("approved");
    expect(user.technicalLevel).toBe("technical");
    expect(user.reviewedBy).toBe("operator");
    expect(user.reviewedAt).not.toBeNull();
    const pending = (
      await app.inject({
        url: "/api/admin/users?status=pending",
        headers: { cookie: operator },
      })
    ).json<AdminListResponse>();
    expect(pending.users.map((u) => u.id)).not.toContain(fixture.id);
    const rows = await auditFor(fixture.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("approve");
    expect(rows[0].detail).toBe("technical");
    expect(rows[0].actor_id).toBe("operator");
    expect(rows[0].target_user_id).toBe(fixture.id);
  });

  test("double approve is rejected without extra audit", async () => {
    const fixture = await createFixture();
    const first = await app.inject({
      method: "POST",
      url: `/api/admin/users/${fixture.id}/approve`,
      headers: { cookie: operator },
      payload: { technicalLevel: "non_technical" },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/api/admin/users/${fixture.id}/approve`,
      headers: { cookie: operator },
      payload: { technicalLevel: "technical" },
    });
    expect(second.statusCode).toBe(409);
    const rows = await auditFor(fixture.id);
    expect(rows).toHaveLength(1);
    expect(first.json<AdminUser>().technicalLevel).toBe("non_technical");
  });

  test("reject records the reason in status and audit", async () => {
    const fixture = await createFixture();
    const reason = `Not eligible ${randomUUID()}`;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/admin/users/${fixture.id}/reject`,
      headers: { cookie: operator },
      payload: { reason },
    });
    expect(rejected.statusCode).toBe(200);
    const user = rejected.json<AdminUser>();
    expect(user.id).toBe(fixture.id);
    expect(user.accountStatus).toBe("rejected");
    expect(user.reviewedBy).toBe("operator");
    const rows = await auditFor(fixture.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("reject");
    expect(rows[0].detail).toBe(reason);
    expect(rows[0].actor_id).toBe("operator");
  });

  test("operator can re-classify an approved user", async () => {
    const fixture = await createFixture();
    const approved = await app.inject({
      method: "POST",
      url: `/api/admin/users/${fixture.id}/approve`,
      headers: { cookie: operator },
      payload: { technicalLevel: "technical" },
    });
    expect(approved.statusCode).toBe(200);
    const reclassified = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${fixture.id}/classification`,
      headers: { cookie: operator },
      payload: { technicalLevel: "non_technical" },
    });
    expect(reclassified.statusCode).toBe(200);
    const user = reclassified.json<AdminUser>();
    expect(user.accountStatus).toBe("approved");
    expect(user.technicalLevel).toBe("non_technical");
    const rows = await auditFor(fixture.id);
    expect(rows).toHaveLength(2);
    // Same-millisecond created_at ties are possible, so compare as a set.
    const pairs = rows.map((r) => `${r.action}:${r.detail}`).sort();
    expect(pairs).toEqual(["approve:technical", "classification:non_technical"]);
    expect(rows.every((r) => r.actor_id === "operator")).toBe(true);
  });

  test("non-operator gets 403 on every admin route; anonymous gets 401", async () => {
    const fixture = await createFixture();
    const adminCalls = [
      { method: "GET" as const, url: "/api/admin/users?status=pending" },
      { method: "GET" as const, url: "/api/admin/actions" },
      {
        method: "POST" as const,
        url: `/api/admin/users/${fixture.id}/approve`,
        payload: { technicalLevel: "technical" },
      },
      {
        method: "POST" as const,
        url: `/api/admin/users/${fixture.id}/reject`,
        payload: { reason: `Spam ${randomUUID()}` },
      },
      {
        method: "PATCH" as const,
        url: `/api/admin/users/${fixture.id}/classification`,
        payload: { technicalLevel: "technical" },
      },
    ];
    for (const call of adminCalls) {
      const denied = await app.inject({
        ...call,
        headers: { cookie: alice },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("forbidden");
      const anonymous = await app.inject({ ...call });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json().code).toBe("unauthorized");
    }
    // Denied attempts change nothing: still pending, no audit trail.
    const pending = (
      await app.inject({
        url: "/api/admin/users?status=pending",
        headers: { cookie: operator },
      })
    ).json<AdminListResponse>();
    expect(pending.users.map((u) => u.id)).toContain(fixture.id);
    expect(await auditFor(fixture.id)).toHaveLength(0);
  });

  test("pending users cannot provision; approval lifts the block", async () => {
    const fixture = await createFixture();
    const blocked = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: fixture.cookie },
      payload: { name: `Provision ${fixture.id.slice(0, 8)}`, planId: "game-small" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("AccountPending");
    const approved = await app.inject({
      method: "POST",
      url: `/api/admin/users/${fixture.id}/approve`,
      headers: { cookie: operator },
      payload: { technicalLevel: "non_technical" },
    });
    expect(approved.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: fixture.cookie },
      payload: { name: `Provision ${fixture.id.slice(0, 8)}`, planId: "game-small" },
    });
    expect(created.statusCode).toBe(201);
  });

  test("operator pages the moderation audit feed", async () => {
    const approvedFixture = await createFixture();
    const rejectedFixture = await createFixture();
    const reason = `No capacity ${randomUUID()}`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${approvedFixture.id}/approve`,
          headers: { cookie: operator },
          payload: { technicalLevel: "technical" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${rejectedFixture.id}/reject`,
          headers: { cookie: operator },
          payload: { reason },
        })
      ).statusCode,
    ).toBe(200);
    const filtered = (
      await app.inject({
        url: `/api/admin/actions?targetUserId=${approvedFixture.id}`,
        headers: { cookie: operator },
      })
    ).json<AdminActionsResponse>();
    expect(filtered.actions).toHaveLength(1);
    expect(filtered.actions[0].targetUserId).toBe(approvedFixture.id);
    expect(filtered.actions[0].actorId).toBe("operator");
    expect(filtered.actions[0].action).toBe("approve");
    expect(filtered.actions[0].detail).toBe("technical");
    expect(typeof filtered.actions[0].createdAt).toBe("string");
    const first = (
      await app.inject({
        url: "/api/admin/actions?limit=1",
        headers: { cookie: operator },
      })
    ).json<AdminActionsResponse>();
    expect(first.actions).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = (
      await app.inject({
        url: `/api/admin/actions?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
        headers: { cookie: operator },
      })
    ).json<AdminActionsResponse>();
    const seen = [...first.actions, ...second.actions]
      .map((a) => a.targetUserId)
      .sort();
    expect(seen).toEqual([approvedFixture.id, rejectedFixture.id].sort());
    const badCursor = await app.inject({
      url: "/api/admin/actions?cursor=!!!not-base64!!!",
      headers: { cookie: operator },
    });
    expect(badCursor.statusCode).toBe(400);
  });
});
