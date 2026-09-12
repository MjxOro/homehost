import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { PLANS, TIER_QUOTAS } from "@homehost/shared";
import type {
  ActivityEvent,
  ApprovalResponse,
  DashboardResponse,
  DemoPersona,
  PortalUser,
  ServerRequest,
  SessionResponse,
} from "@homehost/shared";
import { createDb, type Database } from "./db/client.js";
import * as schema from "./db/schema.js";
import { getEnv } from "./env.js";
import { Effect, Either, ManagedRuntime } from "effect";
import { DatabaseLive } from "./domain/Database.js";
import type { DomainError } from "./domain/errors.js";
import {
  cancelRequest,
  createRequest,
  decideRequest,
} from "./domain/requests.js";

const SESSION_COOKIE = "hh_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

const DEMO_PERSONAS: DemoPersona[] = [
  { id: "alice", name: "Alice Chen", tier: "untrusted", role: "member" },
  { id: "bob", name: "Bob Martin", tier: "trusted", role: "member" },
  { id: "operator", name: "Lab Operator", tier: "trusted", role: "operator" },
];

const DemoSessionBody = z
  .object({ personaId: z.enum(["alice", "bob", "operator"]) })
  .strict();
const CreateRequestBody = z
  .object({ name: z.string().trim().min(1).max(48), planId: z.string().min(1) })
  .strict();
const DecisionBody = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
const IdParams = z.object({ id: z.string().uuid() }).strict();

export interface BuildAppOptions {
  db?: Database;
  databaseUrl?: string;
  baseDomain?: string;
  appOrigin?: string;
}

interface Session {
  user: PortalUser;
  tokenHash: string;
}

function sendErr(
  reply: FastifyReply,
  status: number,
  error: string,
  code: string,
) {
  return reply.code(status).send({ error, code });
}

function zodMessage(
  issues: { path: (string | number)[]; message: string }[],
): string {
  return issues
    .map((i) =>
      i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
    )
    .join("; ");
}

function sendDomainError(reply: FastifyReply, e: DomainError) {
  switch (e._tag) {
    case "QuotaExceeded":
      return sendErr(reply, 429, "quota exceeded", "quota");
    case "SubdomainTaken":
      return sendErr(reply, 409, "subdomain already taken", "conflict");
    case "RequestNotFound":
      return sendErr(reply, 404, "request not found", "not_found");
    case "TransitionConflict":
      return sendErr(reply, 409, "request is no longer pending", "conflict");
    case "DbFailure":
      throw e.cause;
    default: {
      const _exhaustive: never = e;
      throw _exhaustive;
    }
  }
}

type RequestRow = typeof schema.serverRequests.$inferSelect;
type EventRow = typeof schema.activityEvents.$inferSelect;

function toServerRequest(r: RequestRow): ServerRequest {
  return {
    id: r.id,
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    name: r.name,
    planId: r.planId,
    status: r.status as ServerRequest["status"],
    subdomain: r.subdomain,
    cpu: r.cpu,
    memoryMb: r.memoryMb,
    diskGb: r.diskGb,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    decisionReason: r.decisionReason,
  };
}

function toActivityEvent(e: EventRow): ActivityEvent {
  return {
    id: e.id,
    requestId: e.requestId,
    actorName: e.actorName,
    action: e.action as ActivityEvent["action"],
    serverName: e.serverName,
    createdAt: e.createdAt.toISOString(),
    detail: e.detail,
  };
}

export function buildApp(opts?: BuildAppOptions): FastifyInstance {
  // Showcase safety gates always apply, including smoke-injected instances.
  const env = getEnv();
  const baseDomain = opts?.baseDomain ?? env.baseDomain;
  const allowedOrigins = new Set([
    new URL(opts?.appOrigin ?? env.appOrigin).origin,
    new URL(env.apiOrigin).origin,
  ]);
  const handle = opts?.db
    ? null
    : createDb(opts?.databaseUrl ?? env.databaseUrl);
  const db: Database = opts?.db ?? (handle as { db: Database }).db;
  const runtime = ManagedRuntime.make(DatabaseLive(db));

  const app = Fastify({ logger: true });

  async function resolveSession(req: FastifyRequest): Promise<Session | null> {
    const header = req.headers.cookie;
    let token: string | null = null;
    if (header) {
      for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx >= 0 && part.slice(0, idx).trim() === SESSION_COOKIE) {
          // Minted tokens are 64 lowercase hex chars; never percent-decode untrusted input.
          token = part.slice(idx + 1).trim();
          break;
        }
      }
    }
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const rows = await db
      .select()
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(eq(schema.sessions.tokenHash, tokenHash))
      .limit(1);
    if (rows.length === 0) return null;
    const s = rows[0].sessions;
    const u = rows[0].users;
    if (s.expiresAt.getTime() <= Date.now()) {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, tokenHash));
      return null;
    }
    return {
      user: {
        id: u.id,
        name: u.name,
        role: u.role as PortalUser["role"],
        tier: u.tier as PortalUser["tier"],
      },
      tokenHash,
    };
  }

  // Deny cross-site mutations. Only the exact configured browser origin and the
  // API's own origin pass; localhost ports are not wildcards, proxy headers untrusted.
  app.addHook("preHandler", async (req, reply) => {
    if (
      req.method === "GET" ||
      req.method === "HEAD" ||
      req.method === "OPTIONS"
    )
      return;
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site === "cross-site") {
      return sendErr(
        reply,
        403,
        "cross-site mutations are forbidden",
        "forbidden",
      );
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0) {
      let normalized: string | null = null;
      try {
        const parsed = new URL(origin);
        if (parsed.protocol === "http:" || parsed.protocol === "https:")
          normalized = parsed.origin;
      } catch {
        normalized = null;
      }
      if (!normalized || !allowedOrigins.has(normalized)) {
        return sendErr(
          reply,
          403,
          "cross-origin mutations are forbidden",
          "forbidden",
        );
      }
    }
  });

  function requireJsonBody(req: FastifyRequest, reply: FastifyReply): boolean {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      sendErr(
        reply,
        400,
        "content-type application/json is required",
        "invalid",
      );
      return false;
    }
    return true;
  }

  app.setNotFoundHandler((_req, reply) =>
    sendErr(reply, 404, "not found", "not_found"),
  );
  app.setErrorHandler((err, _req, reply) => {
    if (reply.sent) return;
    let status = 500;
    if (
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
    ) {
      status = err.statusCode;
    }
    if (status >= 500) app.log.error(err);
    if (status >= 500) return sendErr(reply, 500, "internal error", "internal");
    const message =
      err instanceof Error && err.message ? err.message : "bad request";
    return sendErr(reply, status, message, "invalid");
  });

  app.get("/api/health", async () => ({ ok: true, mode: "showcase" }));

  app.get("/api/session", async (req): Promise<SessionResponse> => {
    const session = await resolveSession(req);
    return {
      mode: "showcase",
      user: session?.user ?? null,
      personas: DEMO_PERSONAS,
    };
  });

  app.post("/api/demo/session", async (req, reply) => {
    if (!requireJsonBody(req, reply)) return;
    const parsed = DemoSessionBody.safeParse(req.body);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    const userRows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, parsed.data.personaId))
      .limit(1);
    if (userRows.length === 0)
      return sendErr(reply, 404, "unknown persona", "not_found");
    const u = userRows[0];
    const old = await resolveSession(req);
    if (old)
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, old.tokenHash));
    const now = new Date();
    await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
    const token = randomBytes(32).toString("hex");
    await db.insert(schema.sessions).values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: u.id,
      expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_S * 1000),
    });
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`,
    );
    return {
      mode: "showcase",
      user: {
        id: u.id,
        name: u.name,
        role: u.role as PortalUser["role"],
        tier: u.tier as PortalUser["tier"],
      },
      personas: DEMO_PERSONAS,
    };
  });

  app.delete("/api/session", async (req, reply) => {
    const session = await resolveSession(req);
    if (session) {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, session.tokenHash));
    }
    // Clearing lives in the successful handler, never in a global hook that also
    // fires for denied cross-site logout attempts.
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
    return { ok: true };
  });

  app.get("/api/plans", async () => PLANS);

  app.get("/api/dashboard", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    const requests = await db
      .select()
      .from(schema.serverRequests)
      .where(
        and(
          eq(schema.serverRequests.ownerId, session.user.id),
          ne(schema.serverRequests.status, "deleted"),
        ),
      )
      .orderBy(
        desc(schema.serverRequests.createdAt),
        desc(schema.serverRequests.id),
      );
    const eventRows = await db
      .select({ event: schema.activityEvents })
      .from(schema.activityEvents)
      .innerJoin(
        schema.serverRequests,
        eq(schema.activityEvents.requestId, schema.serverRequests.id),
      )
      .where(eq(schema.serverRequests.ownerId, session.user.id))
      .orderBy(
        desc(schema.activityEvents.createdAt),
        desc(schema.activityEvents.id),
      )
      .limit(50);
    const events = eventRows.map((r) => r.event);
    const usage = { servers: 0, cpu: 0, memoryMb: 0, diskGb: 0 };
    for (const r of requests) {
      if (r.status === "pending_approval" || r.status === "approved") {
        usage.servers += 1;
        usage.cpu += r.cpu;
        usage.memoryMb += r.memoryMb;
        usage.diskGb += r.diskGb;
      }
    }
    return {
      user: session.user,
      quota: { ...TIER_QUOTAS[session.user.tier] },
      usage,
      requests: requests.map(toServerRequest),
      activity: events.map(toActivityEvent),
    };
  });

  app.post("/api/requests", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    if (!requireJsonBody(req, reply)) return;
    const parsed = CreateRequestBody.safeParse(req.body);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    const plan = PLANS.find((p) => p.id === parsed.data.planId);
    if (!plan) return sendErr(reply, 404, "unknown plan", "not_found");
    if (plan.trustedOnly && session.user.tier !== "trusted") {
      return sendErr(reply, 403, "plan requires trusted tier", "forbidden");
    }
    const created = await runtime.runPromise(
      Effect.either(
        createRequest({
          user: session.user,
          name: parsed.data.name,
          plan,
          baseDomain,
        }),
      ),
    );
    return Either.match(created, {
      onLeft: (e) => sendDomainError(reply, e),
      onRight: (row) => reply.code(201).send(toServerRequest(row)),
    });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/requests/:id",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      // Existence, ownership and non-deleted are rechecked under row lock inside the
      // transaction, so a losing concurrent cancellation gets 404, never a duplicate event.
      const cancelled = await runtime.runPromise(
        Effect.either(
          cancelRequest({ id: params.data.id, user: session.user }),
        ),
      );
      return Either.match(cancelled, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: () => ({ ok: true as const }),
      });
    },
  );

  app.get("/api/approvals", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    if (session.user.role !== "operator") {
      return sendErr(reply, 403, "operator role required", "forbidden");
    }
    const rows = await db
      .select()
      .from(schema.serverRequests)
      .where(eq(schema.serverRequests.status, "pending_approval"))
      .orderBy(
        desc(schema.serverRequests.createdAt),
        desc(schema.serverRequests.id),
      );
    return { requests: rows.map(toServerRequest) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/requests/:id/decision",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      if (session.user.role !== "operator") {
        return sendErr(reply, 403, "operator role required", "forbidden");
      }
      if (!requireJsonBody(req, reply)) return;
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const parsed = DecisionBody.safeParse(req.body);
      if (!parsed.success)
        return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
      const trimmedReason = parsed.data.reason?.trim() ?? "";
      const reason = trimmedReason ? trimmedReason : null;
      const decided = await runtime.runPromise(
        Effect.either(
          decideRequest({
            id: params.data.id,
            actorName: session.user.name,
            decision: parsed.data.decision,
            reason,
          }),
        ),
      );
      return Either.match(decided, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: (row) => toServerRequest(row),
      });
    },
  );

  app.addHook("onClose", async () => {
    await runtime.dispose();
    if (handle) await handle.sql.end();
  });

  return app;
}
