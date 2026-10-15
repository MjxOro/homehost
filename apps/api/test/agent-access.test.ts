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
import {
  ACCESS_TOKEN_PATTERN,
  type AccessToken,
  type AccessTokenListResponse,
  type AgentMachineListResponse,
  type CreatedAccessToken,
  type ExecResult,
  type FileReadResult,
} from "@homehost/shared";

type ExecRowRaw = {
  id: string;
  op: string;
  command: string | null;
  path: string | null;
  input: Buffer | null;
  file_mode: number | null;
  timeout_ms: number;
  max_bytes: number;
};

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "agent access tokens, machine API and MCP",
  () => {
    const namespace = `test_${randomUUID().replaceAll("-", "")}`;
    let admin: postgres.Sql;
    let client: postgres.Sql;
    let worker: postgres.Sql;
    let app: FastifyInstance;
    let bob: string;
    let alice: string;
    const seen: ExecRowRaw[] = [];
    // The fake worker finishes each queued row the way the Go exec pool does.
    let finish: (row: ExecRowRaw) => Promise<void>;

    const done = (row: ExecRowRaw, stdout: string, exitCode = 0) =>
      worker`UPDATE machine_execs SET status = 'done', exit_code = ${exitCode},
      stdout = ${Buffer.from(stdout)}, stderr = ${Buffer.from("")},
      started_at = now(), finished_at = now(), input = NULL
      WHERE id = ${row.id}`.then(() => undefined);
    const failed = (row: ExecRowRaw, code: string) =>
      worker`UPDATE machine_execs SET status = 'failed', error = ${code},
      finished_at = now(), input = NULL WHERE id = ${row.id}`.then(
        () => undefined,
      );
    const defaultFinish = (row: ExecRowRaw) =>
      done(row, row.op === "command" ? `ran: ${row.command}` : "file body");

    beforeAll(async () => {
      admin = postgres(databaseUrl!, { max: 1 });
      await admin.unsafe(`CREATE SCHEMA ${namespace}`);
      client = postgres(databaseUrl!, {
        connection: { search_path: namespace },
        max: 8,
      });
      const dir = new URL("../migrations/", import.meta.url);
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        await client.unsafe(await readFile(new URL(f, dir), "utf8"));
      }
      worker = postgres(databaseUrl!, {
        connection: { search_path: namespace },
        max: 2,
      });
      finish = defaultFinish;
      await worker.listen("machine_execs", async (id) => {
        const [row] = await worker<ExecRowRaw[]>`
        UPDATE machine_execs SET status = 'running', started_at = now()
        WHERE id = ${id} AND status = 'queued'
        RETURNING id, op, command, path, input, file_mode, timeout_ms, max_bytes`;
        if (!row) return;
        seen.push(row);
        await finish(row);
      });
      app = buildApp({ db: drizzle(client, { schema }) });
      async function login(personaId: string) {
        const response = await app.inject({
          method: "POST",
          url: "/api/demo/session",
          payload: { personaId },
        });
        expect(response.statusCode).toBe(200);
        return String(response.headers["set-cookie"]).split(";")[0]!;
      }
      [bob, alice] = await Promise.all([login("bob"), login("alice")]);
    });

    afterEach(async () => {
      finish = defaultFinish;
      seen.length = 0;
      await client`UPDATE users SET account_status = 'approved' WHERE id = 'bob'`;
      await client`TRUNCATE machine_execs, access_tokens, agent_messages, agent_conversations, provision_jobs, activity_events, server_requests`;
    });

    afterAll(async () => {
      if (app) await app.close();
      if (worker) await worker.end();
      if (client) await client.end();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
        await admin.end();
      }
    });

    async function machine(owner: string, name: string, status = "running") {
      const short = randomUUID().replaceAll("-", "").slice(0, 8);
      const [row] = await client<{ id: string }[]>`
      INSERT INTO server_requests
        (owner_id, owner_name, name, plan_id, status, subdomain, cpu, memory_mb, disk_gb, instance_name)
      VALUES (${owner}, ${owner}, ${name}, 'container-small', ${status},
        ${`${name}-${short}.test.example`}, 1, 512, 5, ${`req-${short}`})
      RETURNING id`;
      return row!.id;
    }

    async function issue(
      cookie: string,
      body: Partial<{
        name: string;
        scopes: string[];
        machineIds: string[] | null;
        expiresInDays: number;
      }> = {},
    ) {
      const response = await app.inject({
        method: "POST",
        url: "/api/access-tokens",
        headers: { cookie },
        payload: {
          name: "laptop agent",
          scopes: ["machines:read", "machines:exec"],
          machineIds: null,
          expiresInDays: 30,
          ...body,
        },
      });
      return response;
    }

    async function secretFor(
      body: Parameters<typeof issue>[1] = {},
    ): Promise<string> {
      const response = await issue(bob, body);
      expect(response.statusCode).toBe(201);
      return response.json<CreatedAccessToken>().secret;
    }

    const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

    test("a token is shown once, hashed at rest, listed by hint and revocable", async () => {
      const created = await issue(bob);
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const { token, secret } = created.json<CreatedAccessToken>();
      expect(secret).toMatch(ACCESS_TOKEN_PATTERN);
      expect(token.hint).toBe(secret.slice(-4));
      const [stored] = await client<{ token_hash: string }[]>`
      SELECT token_hash FROM access_tokens WHERE id = ${token.id}`;
      expect(stored!.token_hash).not.toContain(secret);

      const listed = await app.inject({
        method: "GET",
        url: "/api/access-tokens",
        headers: { cookie: bob },
      });
      expect(JSON.stringify(listed.json())).not.toContain(secret);
      expect(
        listed.json<AccessTokenListResponse>().tokens.map((t) => t.id),
      ).toEqual([token.id]);

      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/machines",
            headers: bearer(secret),
          })
        ).statusCode,
      ).toBe(200);
      const foreign = await app.inject({
        method: "DELETE",
        url: `/api/access-tokens/${token.id}`,
        headers: { cookie: alice },
      });
      expect(foreign.statusCode).toBe(404);
      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/access-tokens/${token.id}`,
        headers: { cookie: bob },
      });
      expect(revoked.json<AccessToken>().revokedAt).not.toBeNull();
      const after = await app.inject({
        method: "GET",
        url: "/api/machines",
        headers: bearer(secret),
      });
      expect(after.statusCode).toBe(401);
      expect(after.json().code).toBe("unauthorized");
    });

    test("bearer routes ignore cookies and reject expired tokens and suspended owners", async () => {
      const cookieOnly = await app.inject({
        method: "GET",
        url: "/api/machines",
        headers: { cookie: bob },
      });
      expect(cookieOnly.statusCode).toBe(401);
      expect(cookieOnly.headers["www-authenticate"]).toContain("Bearer");

      const secret = await secretFor();
      await client`UPDATE users SET account_status = 'suspended' WHERE id = 'bob'`;
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/machines",
            headers: bearer(secret),
          })
        ).statusCode,
      ).toBe(401);
      await client`UPDATE users SET account_status = 'approved' WHERE id = 'bob'`;
      await client`UPDATE access_tokens SET expires_at = now() - interval '1 second'`;
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/machines",
            headers: bearer(secret),
          })
        ).statusCode,
      ).toBe(401);
    });

    test("only approved accounts mint tokens, within the active-token cap", async () => {
      await client`UPDATE users SET account_status = 'pending' WHERE id = 'bob'`;
      const pending = await issue(bob);
      expect(pending.statusCode).toBe(403);
      expect(pending.json().code).toBe("AccountPending");
      await client`UPDATE users SET account_status = 'approved' WHERE id = 'bob'`;

      const aliceMachine = await machine("alice", "theirs");
      const foreign = await issue(bob, { machineIds: [aliceMachine] });
      expect(foreign.statusCode).toBe(404);

      await client`
      INSERT INTO access_tokens (user_id, name, token_hash, token_hint, scopes, expires_at)
      SELECT 'bob', 'filler', md5(random()::text) || g::text, 'xxxx',
        ARRAY['machines:read'], now() + interval '1 day'
      FROM generate_series(1, 20) g`;
      const capped = await issue(bob);
      expect(capped.statusCode).toBe(429);
      expect(capped.json().code).toBe("token_limit");
    });

    test("tokens see only their own machines and need the matching scope", async () => {
      const web = await machine("bob", "web");
      await machine("bob", "db");
      await machine("bob", "gone", "deleted");
      const theirs = await machine("alice", "theirs");
      const all = await secretFor({ scopes: ["machines:read"] });
      const listed = await app.inject({
        method: "GET",
        url: "/api/machines",
        headers: bearer(all),
      });
      expect(
        listed.json<AgentMachineListResponse>().machines.map((m) => m.name),
      ).toEqual(["web", "db"]);
      const one = listed.json<AgentMachineListResponse>().machines[0]!;
      expect(one).toMatchObject({ kind: "container", status: "running" });
      expect(one.capabilities).toEqual(["exec", "files", "power"]);

      const pinned = await secretFor({ machineIds: [web] });
      const pinnedList = await app.inject({
        method: "GET",
        url: "/api/machines",
        headers: bearer(pinned),
      });
      expect(
        pinnedList.json<AgentMachineListResponse>().machines.map((m) => m.id),
      ).toEqual([web]);
      for (const ref of ["db", theirs]) {
        const hidden = await app.inject({
          method: "GET",
          url: `/api/machines/${ref}`,
          headers: bearer(pinned),
        });
        expect(hidden.statusCode).toBe(404);
      }

      const readOnly = await app.inject({
        method: "POST",
        url: "/api/machines/web/exec",
        headers: bearer(all),
        payload: { command: "uptime" },
      });
      expect(readOnly.statusCode).toBe(403);
      expect(readOnly.json().code).toBe("scope_required");
      expect(seen).toHaveLength(0);
    });

    test("exec and file operations round-trip through the worker queue", async () => {
      await machine("bob", "web");
      await machine("bob", "sleepy", "stopped");
      const secret = await secretFor();

      const ran = await app.inject({
        method: "POST",
        url: "/api/machines/web/exec",
        headers: bearer(secret),
        payload: { command: "uname -a", cwd: "/srv", timeoutSeconds: 5 },
      });
      expect(ran.statusCode).toBe(200);
      expect(ran.json<ExecResult>()).toMatchObject({
        exitCode: 0,
        timedOut: false,
        stdout: "ran: uname -a",
      });
      expect(seen[0]).toMatchObject({ op: "command", timeout_ms: 5000 });

      finish = async (row) => {
        expect(row.input?.toString("utf8")).toBe("hello\n");
        expect(row.file_mode).toBe(0o600);
        await done(row, "");
      };
      const wrote = await app.inject({
        method: "POST",
        url: "/api/machines/web/files/write",
        headers: bearer(secret),
        payload: { path: "/root/note.txt", content: "hello\n", mode: 0o600 },
      });
      expect(wrote.json()).toEqual({ path: "/root/note.txt", bytes: 6 });
      const [cleared] = await client<{ input: Buffer | null }[]>`
      SELECT input FROM machine_execs WHERE op = 'write_file'`;
      expect(cleared!.input).toBeNull();

      finish = defaultFinish;
      const read = await app.inject({
        method: "POST",
        url: "/api/machines/web/files/read",
        headers: bearer(secret),
        payload: { path: "/etc/hostname" },
      });
      expect(read.json<FileReadResult>()).toMatchObject({
        encoding: "utf8",
        content: "file body",
        truncated: false,
      });

      finish = (row) => failed(row, "file_not_found");
      const missing = await app.inject({
        method: "POST",
        url: "/api/machines/web/files/read",
        headers: bearer(secret),
        payload: { path: "/nope" },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("file_not_found");

      const stopped = await app.inject({
        method: "POST",
        url: "/api/machines/sleepy/exec",
        headers: bearer(secret),
        payload: { command: "true" },
      });
      expect(stopped.statusCode).toBe(409);
      expect(stopped.json().code).toBe("machine_not_running");
    });

    test("a token cannot exceed its in-flight operation cap", async () => {
      const web = await machine("bob", "web");
      const secret = await secretFor();
      const [token] = await client<
        { id: string }[]
      >`SELECT id FROM access_tokens`;
      await client`
      INSERT INTO machine_execs (request_id, user_id, token_id, op, command, max_bytes, timeout_ms, status)
      SELECT ${web}, 'bob', ${token!.id}, 'command', 'sleep 60', 1024, 60000, 'running'
      FROM generate_series(1, 4)`;
      const busy = await app.inject({
        method: "POST",
        url: "/api/machines/web/exec",
        headers: bearer(secret),
        payload: { command: "true" },
      });
      expect(busy.statusCode).toBe(429);
      expect(busy.json().code).toBe("exec_busy");
    });

    test("power actions queue the existing provision jobs", async () => {
      await machine("bob", "web");
      const noPower = await secretFor();
      const denied = await app.inject({
        method: "POST",
        url: "/api/machines/web/power",
        headers: bearer(noPower),
        payload: { action: "stop" },
      });
      expect(denied.statusCode).toBe(403);
      const secret = await secretFor({ scopes: ["machines:power"] });
      const stopped = await app.inject({
        method: "POST",
        url: "/api/machines/web/power",
        headers: bearer(secret),
        payload: { action: "stop" },
      });
      expect(stopped.statusCode).toBe(200);
      const jobs = await client<
        { action: string }[]
      >`SELECT action FROM provision_jobs`;
      expect(jobs.map((j) => j.action)).toEqual(["stop"]);
      const wrongState = await app.inject({
        method: "POST",
        url: "/api/machines/web/power",
        headers: bearer(secret),
        payload: { action: "start" },
      });
      expect(wrongState.statusCode).toBe(409);
    });

    test("the MCP endpoint lists scoped tools and calls them", async () => {
      await machine("bob", "web");
      const secret = await secretFor();
      const rpc = (body: unknown, token: string | null = secret) =>
        app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: {
            ...(token ? bearer(token) : {}),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          payload: body as Record<string, unknown>,
        });

      expect(
        (await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null)).statusCode,
      ).toBe(401);

      const init = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      expect(init.json().result).toMatchObject({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "homehost" },
      });
      const note = await rpc({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(note.statusCode).toBe(202);

      const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(
        list.json().result.tools.map((t: { name: string }) => t.name),
      ).toEqual([
        "list_machines",
        "machine_status",
        "run_command",
        "read_file",
        "write_file",
      ]);

      const machines = await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_machines", arguments: {} },
      });
      expect(machines.json().result.structuredContent.machines[0].name).toBe(
        "web",
      );

      const ran = await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "run_command",
          arguments: { machine: "web", command: "id -u" },
        },
      });
      expect(ran.json().result.structuredContent).toMatchObject({
        exitCode: 0,
        stdout: "ran: id -u",
      });

      const power = await rpc({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "set_power",
          arguments: { machine: "web", action: "stop" },
        },
      });
      expect(power.json().result.isError).toBe(true);
      expect(JSON.parse(power.json().result.content[0].text).code).toBe(
        "scope_required",
      );

      const bad = await rpc({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "run_command", arguments: { machine: "web" } },
      });
      expect(bad.json().result.isError).toBe(true);

      const unknown = await rpc({
        jsonrpc: "2.0",
        id: 7,
        method: "resources/list",
      });
      expect(unknown.json().error.code).toBe(-32601);
      expect(
        (await app.inject({ method: "GET", url: "/api/mcp" })).statusCode,
      ).toBe(405);
    });
  },
);
