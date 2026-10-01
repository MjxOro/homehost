import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { runInNewContext } from "node:vm";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import {
  DESKTOP_CSP,
  DESKTOP_BRIDGE_CHANNEL,
  type ServerRequest,
} from "@homehost/shared";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import {
  desktopBridgeScript,
  desktopJavascript,
} from "../src/desktop-bridge.js";
import {
  createDesktopTickets,
  DESKTOP_TICKET_TTL_S,
  redactDesktopUrl,
} from "../src/auth/desktop-tickets.js";

test("desktop capability validates signature, expiry, bounded input and fresh nonce", () => {
  let now = Date.now();
  const issuer = createDesktopTickets(
    randomBytes(32).toString("base64"),
    () => now,
  );
  const id = randomUUID(),
    user = randomUUID(),
    ticket = issuer.mint(id, user);
  expect(issuer.verify(ticket)).toMatchObject({ requestId: id, userId: user });
  expect(issuer.mint(id, user)).not.toBe(ticket);
  const parts = ticket.split(".");
  const payload = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
  payload.userId = randomUUID();
  expect(
    issuer.verify(
      `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[1]}`,
    ),
  ).toBeNull();
  expect(
    issuer.verify(`${parts[0]}.${randomBytes(32).toString("base64url")}`),
  ).toBeNull();
  expect(issuer.verify("x".repeat(701))).toBeNull();
  now += DESKTOP_TICKET_TTL_S * 1000;
  expect(issuer.verify(ticket)).toBeNull();
  expect(redactDesktopUrl(`/api/desktop/t/${ticket}/dist/a.js?x=1`)).toBe(
    "/api/desktop/t/[redacted]/dist/a.js?x=1",
  );
});

test("Kasm preferences work while native storage stays denied", () => {
  const memory = new Map<string, string>();
  const window = {
    __homehostDesktopSettings: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    },
  };
  Object.defineProperty(window, "localStorage", {
    get() {
      throw Error("opaque storage denied");
    },
  });
  const source = `
    window.localStorage.setItem('quality', '9');
    result = localStorage.getItem('quality');
    localStorage.removeItem('quality');
  `;
  const context = { window, result: null };
  runInNewContext(desktopJavascript(source, "dist/main.bundle.js"), context);
  expect(context.result).toBe("9");
  expect(memory.size).toBe(0);
  expect(() => Reflect.get(window, "localStorage")).toThrow(
    "opaque storage denied",
  );
  expect(desktopJavascript(source, "vendor/other.js")).toBe(source);
});

test("input bridge focuses the framebuffer and rejects foreign senders and oversized commands", () => {
  const origin = "https://panel.example.test";
  const parent = { postMessage() {} };
  let receive = (_event: {
    source: object;
    origin: string;
    data: unknown;
  }) => {};
  let focused = 0;
  const events: string[] = [];
  const canvas = {
    focus() {
      focused++;
    },
    dispatchEvent(event: { type: string; key: string }) {
      events.push(`${event.type}:${event.key}`);
    },
  };
  const document = {
    addEventListener() {},
    querySelector(selector: string) {
      return selector === "#noVNC_container canvas[tabindex]" ? canvas : null;
    },
  };
  const window = {
    addEventListener(_type: string, handler: typeof receive) {
      receive = handler;
    },
  };
  class KeyboardEvent {
    constructor(
      public type: string,
      init: object,
    ) {
      Object.assign(this, init);
    }
  }
  runInNewContext(desktopBridgeScript([origin]), {
    parent,
    window,
    document,
    KeyboardEvent,
  });
  const focus = { channel: DESKTOP_BRIDGE_CHANNEL, type: "focus" };
  receive({ source: {}, origin, data: focus });
  receive({ source: parent, origin: "null", data: focus });
  expect(focused).toBe(0);
  receive({ source: parent, origin, data: focus });
  expect(focused).toBe(1);
  const key = { type: "keydown", key: "Enter", code: "Enter" };
  receive({
    source: parent,
    origin,
    data: {
      channel: DESKTOP_BRIDGE_CHANNEL,
      type: "keys",
      events: Array(9).fill(key),
    },
  });
  expect(events).toEqual([]);
  receive({
    source: parent,
    origin,
    data: {
      channel: DESKTOP_BRIDGE_CHANNEL,
      type: "keys",
      events: [key, { ...key, type: "keyup" }],
    },
  });
  expect(events).toEqual(["keydown:Enter", "keyup:Enter"]);
  expect(focused).toBe(2);
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("desktop proxy security", () => {
  const namespace = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql, client: postgres.Sql, app: FastifyInstance;
  let now = Date.now();
  const issuer = createDesktopTickets(
    randomBytes(32).toString("base64"),
    () => now,
  );
  let bob: string, alice: string, operator: string;
  let port: number;
  const upstreamRequests: { url: string; init: RequestInit }[] = [];
  let fail = false;
  beforeAll(async () => {
    admin = postgres(url!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    client = postgres(url!, { connection: { search_path: namespace }, max: 8 });
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await client.unsafe(await readFile(new URL(file, dir), "utf8"));
    const transport = (async (
      target: string | URL | Request,
      init: RequestInit,
    ) => {
      upstreamRequests.push({ url: String(target), init });
      if (fail) throw Error(randomUUID());
      return new Response(
        "<html><head></head><body><script>window.guest=true</script></body></html>",
        {
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie": randomUUID(),
            "Cache-Control": "public",
          },
        },
      );
    }) as typeof fetch;
    app = buildApp({
      db: drizzle(client, { schema }),
      desktopTickets: issuer,
      desktopFetch: transport,
    });
    const login = async (personaId: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/demo/session",
        payload: { personaId },
      });
      expect(res.statusCode).toBe(200);
      return String(res.headers["set-cookie"]).split(";")[0]!;
    };
    bob = await login("bob");
    alice = await login("alice");
    operator = await login("operator");
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });
  afterEach(async () => {
    now = Date.now();
    fail = false;
    upstreamRequests.length = 0;
    await client`TRUNCATE agent_messages, agent_conversations, provision_jobs, activity_events, server_requests`;
  });
  afterAll(async () => {
    await app?.close();
    await client?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
  });
  async function desktop() {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie: bob },
      payload: { name: "security-test", planId: "desktop-ubuntu" },
    });
    expect(res.statusCode).toBe(201);
    const r = res.json<ServerRequest>();
    await client`UPDATE server_requests SET status='running',ipv4='127.0.0.1',desktop_password=${randomBytes(18).toString("base64url")} WHERE id=${r.id}`;
    return r;
  }
  async function mint(id: string, cookie = bob) {
    return app.inject({
      url: `/api/requests/${id}/desktop`,
      headers: { cookie },
    });
  }
  const path = (response: Awaited<ReturnType<typeof mint>>) =>
    response.json<{ url: string }>().url.split("#")[0]!;
  function upgrade(url: string) {
    return new Promise<number>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write(
          `GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nCookie: ${bob}\r\nOrigin: null\r\n\r\n`,
        ),
      );
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(Error("upgrade timed out"));
      });
      socket.once("error", reject);
      socket.once("data", (data) => {
        resolve(Number(data.toString().split(" ")[1]));
        socket.destroy();
      });
    });
  }
  test("websocket upgrades enforce the same ticket gate even with a valid panel cookie", async () => {
    const r = await desktop();
    expect(await upgrade("/api/desktop/t/invalid/websockify")).toBe(401);
    expect(
      await upgrade(`/api/desktop/t/${issuer.mint(r.id, "alice")}/websockify`),
    ).toBe(404);
    expect(
      await upgrade(`/api/requests/${r.id}/desktop/session/websockify`),
    ).toBe(404);
    const proxy = path(await mint(r.id));
    await client`UPDATE server_requests SET status='stopped' WHERE id=${r.id}`;
    expect(await upgrade(proxy + "websockify")).toBe(404);
    now += DESKTOP_TICKET_TTL_S * 1000;
    expect(await upgrade(proxy + "websockify")).toBe(401);
  });
  test("only owner/operator can mint, while the sandboxed proxy works without panel cookies", async () => {
    const r = await desktop();
    expect((await mint(r.id, alice)).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/api/requests/${r.id}/desktop` })).statusCode,
    ).toBe(401);
    expect((await mint(r.id, operator)).statusCode).toBe(200);
    const issued = await mint(r.id);
    expect(issued.statusCode).toBe(200);
    const proxy = path(issued);
    expect(proxy).toStartWith("/api/desktop/t/");
    const response = await app.inject({
      url: proxy,
      headers: { origin: "null" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(DESKTOP_CSP);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBe("null");
    expect(response.body).toContain(`<base href="${proxy}">`);
    expect(
      new Headers(upstreamRequests.at(-1)!.init.headers).get("cookie"),
    ).toBeNull();
    expect(upstreamRequests.at(-1)!.init.redirect).toBe("manual");
    expect(
      (
        await app.inject({
          url: `/api/requests/${r.id}/desktop/session/`,
          headers: { cookie: bob },
        })
      ).statusCode,
    ).toBe(404);
  });
  test("invalid/expired capabilities and other-user tickets fail with sandboxed errors", async () => {
    const r = await desktop();
    const proxy = path(await mint(r.id));
    const bad = await app.inject({
      url: "/api/desktop/t/invalid/",
      headers: { cookie: bob },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers["content-security-policy"]).toBe(DESKTOP_CSP);
    const foreign = issuer.mint(r.id, "alice");
    expect(
      (await app.inject({ url: `/api/desktop/t/${foreign}/` })).statusCode,
    ).toBe(404);
    now += DESKTOP_TICKET_TTL_S * 1000;
    expect((await app.inject({ url: proxy })).statusCode).toBe(401);
  });
  test("stopped/deleted requests and revoked viewers invalidate a previously issued capability", async () => {
    const r = await desktop();
    const proxy = path(await mint(r.id));
    for (const status of ["stopped", "deleted"]) {
      await client`UPDATE server_requests SET status=${status} WHERE id=${r.id}`;
      const res = await app.inject({ url: proxy });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-security-policy"]).toBe(DESKTOP_CSP);
    }
    await client`UPDATE server_requests SET status='running' WHERE id=${r.id}`;
    await client`UPDATE users SET account_status='suspended' WHERE id='bob'`;
    expect((await app.inject({ url: proxy })).statusCode).toBe(401);
    await client`UPDATE users SET account_status='approved' WHERE id='bob'`;
  });
  test("upstream failures retain the response sandbox and never relay errors or cookies", async () => {
    const r = await desktop();
    fail = true;
    const res = await app.inject({ url: path(await mint(r.id)) });
    fail = false;
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-security-policy"]).toBe(DESKTOP_CSP);
    expect(res.json().error).toBe("desktop unreachable");
  });
});
