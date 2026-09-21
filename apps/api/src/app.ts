import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createHash, randomBytes } from "node:crypto";
import * as tls from "node:tls";
import { and, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  PLANS,
  SSH_KEY_MAX,
  TECHNICAL_LEVELS,
  TIER_QUOTAS,
  isValidSshPublicKey,
} from "@homehost/shared";
import type {
  ActivityEvent,
  ApprovalResponse,
  CredentialsResponse,
  DashboardResponse,
  DemoPersona,
  DesktopSessionResponse,
  PortalUser,
  ServerRequest,
  SessionResponse,
  TechnicalLevel,
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
  readDesktopSession,
  readInstancePassword,
  retryProvision,
  startInstance,
  stopInstance,
} from "./domain/requests.js";
import { ensureOperatorBootstrap } from "./domain/bootstrap.js";
import {
  approveUser,
  listUsers,
  rejectUser,
  setClassification,
  type UserNotFound,
  type UserRow,
} from "./domain/users.js";
import { listActions, type AuditCursor } from "./domain/audit.js";

import {
  clearedSessionCookie,
  sessionCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
} from "./auth/cookies.js";
import { registerOAuth } from "./auth/oauth.js";

const DEMO_PERSONAS: DemoPersona[] = [
  {
    id: "alice",
    name: "Alice Chen",
    tier: "nontechnical",
    role: "member",
    email: null,
  },
  {
    id: "bob",
    name: "Bob Martin",
    tier: "technical",
    role: "member",
    email: null,
  },
  {
    id: "operator",
    name: "Lab Operator",
    tier: "technical",
    role: "operator",
    email: null,
  },
];

const DemoSessionBody = z
  .object({ personaId: z.enum(["alice", "bob", "operator"]) })
  .strict();
const CreateRequestBody = z
  .object({
    name: z.string().trim().min(1).max(48),
    planId: z.string().min(1),
    desktopEnv: z.enum(["ubuntu-xfce", "omarchy"]).optional(),
    sshPubkey: z.string().trim().max(SSH_KEY_MAX).optional(),
  })
  .strict()
  .refine(
    (b) => b.sshPubkey === undefined || isValidSshPublicKey(b.sshPubkey),
    {
      message: "sshPubkey must be a single-line <type> <base64> [comment] key",
    },
  );
const DecisionBody = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
const IdParams = z.object({ id: z.string().uuid() }).strict();
const IdWildcardParams = z
  .object({ id: z.string().uuid(), "*": z.string() })
  .passthrough();
const InviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    tier: z.enum(["technical", "nontechnical"]).default("nontechnical"),
  })
  .strict();

const ADMIN_USERS_PAGE_DEFAULT = 20;
const ADMIN_USERS_PAGE_MAX = 100;

const AdminUsersQuery = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "suspended"]).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_USERS_PAGE_MAX)
      .default(ADMIN_USERS_PAGE_DEFAULT),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .strict();
const TechnicalLevelBody = z
  .object({
    technicalLevel: z.enum(
      TECHNICAL_LEVELS as [TechnicalLevel, ...TechnicalLevel[]],
    ),
  })
  .strict();
const RejectUserBody = z
  .object({ reason: z.string().max(500).optional() })
  .strict();

const AdminActionsQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_USERS_PAGE_MAX)
      .default(ADMIN_USERS_PAGE_DEFAULT),
    cursor: z.string().min(1).max(1000).optional(),
    targetUserId: z.string().min(1).max(128).optional(),
  })
  .strict();

// User ids are opaque text (demo literals like "alice", OAuth "u-<hex>",
// UUID fixtures) — not necessarily UUID-shaped, so IdParams must not apply here.
const UserIdParams = z.object({ id: z.string().min(1).max(128) }).strict();

// Opaque keyset cursor for the audit feed: base64url("<iso>|<id>"), the same
// shape as /api/activity cursors.
function decodeAuditCursor(cursor: string): AuditCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep < 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt: createdAt.toISOString(), id };
  } catch {
    return null;
  }
}

export interface BuildAppOptions {
  db?: Database;
  databaseUrl?: string;
  baseDomain?: string;
  appOrigin?: string;
  appExtraOrigins?: string[];
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
    case "InvalidTransition":
      return sendErr(reply, 409, e.message, "conflict");
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
  const plan = PLANS.find((p) => p.id === r.planId);
  return {
    id: r.id,
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    name: r.name,
    planId: r.planId,
    status: r.status as ServerRequest["status"],
    hasSshKey: r.sshPubkey !== null,
    ipv6: r.ipv6,
    subdomain: r.subdomain,
    instanceName: r.instanceName,
    ipv4: r.ipv4,
    cpu: r.cpu,
    memoryMb: r.memoryMb,
    diskGb: r.diskGb,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    decisionReason: r.decisionReason,
    desktopEnv: r.desktopEnv as ServerRequest["desktopEnv"],
    desktopHostname: r.desktopHostname,
    desktopUrl: r.desktopHostname ? `https://${r.desktopHostname}` : null,
    desktopUser: plan?.desktop?.user ?? null,
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

function sendAdminError(reply: FastifyReply, e: UserNotFound | DomainError) {
  if (e._tag === "UserNotFound")
    return sendErr(reply, 404, "user not found", "not_found");
  if (e._tag === "InvalidTransition" && e.message === "invalid cursor")
    return sendErr(reply, 400, "invalid cursor", "invalid");
  return sendDomainError(reply, e);
}

function toAdminUser(r: UserRow) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    tier: r.tier,
    accountStatus: r.accountStatus,
    technicalLevel: r.technicalLevel,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
  };
}

const ACTIVITY_PAGE_DEFAULT = 20;
const ACTIVITY_PAGE_MAX = 100;

function decodeActivityCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep < 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

const ActivityQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_PAGE_MAX)
      .default(ACTIVITY_PAGE_DEFAULT),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .strict();
export function buildApp(opts?: BuildAppOptions): FastifyInstance {
  // Showcase safety gates always apply, including smoke-injected instances.
  const env = getEnv();
  const baseDomain = opts?.baseDomain ?? env.baseDomain;
  const allowedOrigins = new Set([
    new URL(opts?.appOrigin ?? env.appOrigin).origin,
    ...(opts?.appExtraOrigins ?? env.appExtraOrigins).map(
      (o) => new URL(o).origin,
    ),
    new URL(env.apiOrigin).origin,
  ]);
  const handle = opts?.db
    ? null
    : createDb(opts?.databaseUrl ?? env.databaseUrl);
  const db: Database = opts?.db ?? (handle as { db: Database }).db;
  const runtime = ManagedRuntime.make(DatabaseLive(db));

  const app = Fastify({ logger: true });

  async function sessionFromToken(
    token: string | null | undefined,
  ): Promise<Session | null> {
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
        email: u.email,
      },
      tokenHash,
    };
  }

  async function resolveSessionCookie(
    header: string | null | undefined,
  ): Promise<Session | null> {
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
    return sessionFromToken(token);
  }

  async function resolveSession(req: FastifyRequest): Promise<Session | null> {
    return resolveSessionCookie(req.headers.cookie);
  }

  async function sha1Base64(input: string): Promise<string> {
    const digest = createHash("sha1").update(input).digest();
    return digest.toString("base64");
  }

  // Deny cross-site mutations. The configured browser origin(s) plus the
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

  async function requireOperator(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Session | null> {
    const session = await resolveSession(req);
    if (!session) {
      sendErr(reply, 401, "session required", "unauthorized");
      return null;
    }
    if (session.user.role !== "operator") {
      sendErr(reply, 403, "operator role required", "forbidden");
      return null;
    }
    return session;
  }

  // Provisioning write paths require an approved account. Operators are
  // exempt; everyone else gets 403 AccountPending until an operator approves.
  async function requireApprovedUser(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Session | null> {
    const session = await resolveSession(req);
    if (!session) {
      sendErr(reply, 401, "session required", "unauthorized");
      return null;
    }
    if (session.user.role === "operator") return session;
    const rows = await db
      .select({ accountStatus: schema.users.accountStatus })
      .from(schema.users)
      .where(eq(schema.users.id, session.user.id))
      .limit(1);
    if (rows.length === 0 || rows[0].accountStatus !== "approved") {
      sendErr(reply, 403, "account pending approval", "AccountPending");
      return null;
    }
    return session;
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

  app.get("/api/health", async () => ({
    ok: true,
    mode: env.showcase ? "showcase" : "live",
  }));

  app.get("/api/session", async (req): Promise<SessionResponse> => {
    const session = await resolveSession(req);
    return {
      mode: env.showcase ? "showcase" : "live",
      user: session?.user ?? null,
      personas: env.showcase ? DEMO_PERSONAS : [],
      providers: { google: env.google !== null, github: env.github !== null },
    };
  });

  app.post("/api/demo/session", async (req, reply) => {
    if (!env.showcase)
      return sendErr(reply, 404, "demo logins are disabled", "not_found");
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
    reply.header("Set-Cookie", sessionCookie(token));
    return {
      mode: env.showcase ? "showcase" : "live",
      user: {
        id: u.id,
        name: u.name,
        role: u.role as PortalUser["role"],
        tier: u.tier as PortalUser["tier"],
        email: u.email,
      },
      personas: DEMO_PERSONAS,
      providers: { google: env.google !== null, github: env.github !== null },
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
    reply.header("Set-Cookie", clearedSessionCookie());
    return { ok: true };
  });

  registerOAuth(app, db, env);

  app.post("/api/invites", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    if (session.user.role !== "operator") {
      return sendErr(reply, 403, "operator role required", "forbidden");
    }
    if (!requireJsonBody(req, reply)) return;
    const parsed = InviteBody.safeParse(req.body);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    try {
      const inserted = await db
        .insert(schema.invites)
        .values({
          email: parsed.data.email,
          tier: parsed.data.tier,
          createdBy: session.user.id,
        })
        .returning();
      const row = inserted[0];
      return reply.code(201).send({
        id: row.id,
        email: row.email,
        tier: row.tier,
        usedAt: row.usedAt ? row.usedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      });
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        e.code === "23505"
      ) {
        return sendErr(reply, 409, "invite already exists", "conflict");
      }
      throw e;
    }
  });

  app.get("/api/invites", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    if (session.user.role !== "operator") {
      return sendErr(reply, 403, "operator role required", "forbidden");
    }
    const rows = await db
      .select()
      .from(schema.invites)
      .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id));
    return {
      invites: rows.map((r) => ({
        id: r.id,
        email: r.email,
        tier: r.tier,
        usedAt: r.usedAt ? r.usedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/invites/:id",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      if (session.user.role !== "operator") {
        return sendErr(reply, 403, "operator role required", "forbidden");
      }
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const deleted = await db
        .delete(schema.invites)
        .where(eq(schema.invites.id, params.data.id))
        .returning({ id: schema.invites.id });
      if (deleted.length === 0)
        return sendErr(reply, 404, "invite not found", "not_found");
      return { ok: true };
    },
  );

  app.get("/api/admin/users", async (req, reply) => {
    const operator = await requireOperator(req, reply);
    if (!operator) return;
    const parsed = AdminUsersQuery.safeParse(req.query);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    const page = await runtime.runPromise(
      Effect.either(
        listUsers({
          status: parsed.data.status,
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        }),
      ),
    );
    return Either.match(page, {
      onLeft: (e) => sendAdminError(reply, e),
      onRight: (p) => ({
        users: p.users.map(toAdminUser),
        hasMore: p.hasMore,
        nextCursor: p.nextCursor,
      }),
    });
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/approve",
    async (req, reply) => {
      const operator = await requireOperator(req, reply);
      if (!operator) return;
      if (!requireJsonBody(req, reply)) return;
      const params = UserIdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const parsed = TechnicalLevelBody.safeParse(req.body);
      if (!parsed.success)
        return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
      const result = await runtime.runPromise(
        Effect.either(
          approveUser(
            params.data.id,
            operator.user.id,
            parsed.data.technicalLevel,
          ),
        ),
      );
      return Either.match(result, {
        onLeft: (e) => sendAdminError(reply, e),
        onRight: (row) => toAdminUser(row),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/reject",
    async (req, reply) => {
      const operator = await requireOperator(req, reply);
      if (!operator) return;
      if (!requireJsonBody(req, reply)) return;
      const params = UserIdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const parsed = RejectUserBody.safeParse(req.body);
      if (!parsed.success)
        return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
      const trimmedReason = parsed.data.reason?.trim() ?? "";
      const result = await runtime.runPromise(
        Effect.either(
          rejectUser(
            params.data.id,
            operator.user.id,
            trimmedReason ? trimmedReason : undefined,
          ),
        ),
      );
      return Either.match(result, {
        onLeft: (e) => sendAdminError(reply, e),
        onRight: (row) => toAdminUser(row),
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/admin/users/:id/classification",
    async (req, reply) => {
      const operator = await requireOperator(req, reply);
      if (!operator) return;
      if (!requireJsonBody(req, reply)) return;
      const params = UserIdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const parsed = TechnicalLevelBody.safeParse(req.body);
      if (!parsed.success)
        return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
      const result = await runtime.runPromise(
        Effect.either(
          setClassification(
            params.data.id,
            operator.user.id,
            parsed.data.technicalLevel,
          ),
        ),
      );
      return Either.match(result, {
        onLeft: (e) => sendAdminError(reply, e),
        onRight: (row) => toAdminUser(row),
      });
    },
  );

  app.get("/api/admin/actions", async (req, reply) => {
    const operator = await requireOperator(req, reply);
    if (!operator) return;
    const parsed = AdminActionsQuery.safeParse(req.query);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    let cursor: AuditCursor | undefined;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeAuditCursor(parsed.data.cursor);
      if (!decoded) return sendErr(reply, 400, "invalid cursor", "invalid");
      cursor = decoded;
    }
    const page = await runtime.runPromise(
      Effect.either(
        listActions({
          targetUserId: parsed.data.targetUserId,
          limit: parsed.data.limit,
          cursor,
        }),
      ),
    );
    return Either.match(page, {
      onLeft: (e) => sendDomainError(reply, e),
      onRight: (p) => ({
        actions: p.actions.map((a) => ({
          id: a.id,
          targetUserId: a.targetUserId,
          actorId: a.actorId,
          action: a.action,
          detail: a.detail,
          createdAt: a.createdAt.toISOString(),
        })),
        hasMore: p.hasMore,
        nextCursor:
          p.hasMore && p.nextCursor
            ? Buffer.from(
                `${p.nextCursor.createdAt}|${p.nextCursor.id}`,
                "utf8",
              ).toString("base64url")
            : null,
      }),
    });
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
      .limit(ACTIVITY_PAGE_DEFAULT);
    const events = eventRows.map((r) => r.event);
    const usage = { servers: 0, cpu: 0, memoryMb: 0, diskGb: 0 };
    for (const r of requests) {
      if (
        r.status === "pending_approval" ||
        r.status === "approved" ||
        r.status === "provisioning" ||
        r.status === "running" ||
        r.status === "stopped"
      ) {
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
  app.get("/api/activity", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    const parsed = ActivityQuery.safeParse(req.query);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    const conditions = [eq(schema.serverRequests.ownerId, session.user.id)];
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeActivityCursor(parsed.data.cursor);
      if (!decoded) return sendErr(reply, 400, "invalid cursor", "invalid");
      conditions.push(
        or(
          lt(schema.activityEvents.createdAt, decoded.createdAt),
          and(
            eq(schema.activityEvents.createdAt, decoded.createdAt),
            lt(schema.activityEvents.id, decoded.id),
          ),
        )!,
      );
    }
    const rows = await db
      .select({ event: schema.activityEvents })
      .from(schema.activityEvents)
      .innerJoin(
        schema.serverRequests,
        eq(schema.activityEvents.requestId, schema.serverRequests.id),
      )
      .where(and(...conditions))
      .orderBy(
        desc(schema.activityEvents.createdAt),
        desc(schema.activityEvents.id),
      )
      .limit(parsed.data.limit + 1);
    const hasMore = rows.length > parsed.data.limit;
    const items = rows.slice(0, parsed.data.limit).map((r) => r.event);
    const last = items[items.length - 1];
    return {
      activity: items.map(toActivityEvent),
      hasMore,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              `${last.createdAt.toISOString()}|${last.id}`,
              "utf8",
            ).toString("base64url")
          : null,
    };
  });

  app.post("/api/requests", async (req, reply) => {
    const session = await requireApprovedUser(req, reply);
    if (!session) return;
    if (!requireJsonBody(req, reply)) return;
    const parsed = CreateRequestBody.safeParse(req.body);
    if (!parsed.success)
      return sendErr(reply, 400, zodMessage(parsed.error.issues), "invalid");
    const plan = PLANS.find((p) => p.id === parsed.data.planId);
    if (!plan) return sendErr(reply, 404, "unknown plan", "not_found");
    if (plan.technicalOnly && session.user.tier !== "technical") {
      return sendErr(reply, 403, "plan requires technical tier", "forbidden");
    }
    // Desktop env must match the plan's GUI stack; a headless plan with a
    // desktopEnv (or a desktop plan with the wrong env) is a 403, mirroring
    // the technicalOnly gate. Desktop plans may omit it (defaults to the
    // plan's env).
    const desktop = plan.desktop;
    if (
      desktop &&
      parsed.data.desktopEnv !== undefined &&
      parsed.data.desktopEnv !== desktop.env
    ) {
      return sendErr(
        reply,
        403,
        "desktop env does not match plan",
        "forbidden",
      );
    }
    if (!desktop && parsed.data.desktopEnv !== undefined) {
      return sendErr(reply, 403, "plan has no desktop", "forbidden");
    }
    // The worker installs sshd on containers too, so all plans accept ssh keys.
    const created = await runtime.runPromise(
      Effect.either(
        createRequest({
          user: session.user,
          name: parsed.data.name,
          plan,
          baseDomain,
          sshPubkey: parsed.data.sshPubkey,
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
      const session = await requireApprovedUser(req, reply);
      if (!session) return;
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

  app.get("/api/instances", async (req, reply) => {
    const session = await resolveSession(req);
    if (!session)
      return sendErr(reply, 401, "session required", "unauthorized");
    if (session.user.role !== "operator") {
      return sendErr(reply, 403, "operator role required", "forbidden");
    }
    const rows = await db
      .select()
      .from(schema.serverRequests)
      .where(
        inArray(schema.serverRequests.status, [
          "approved",
          "provisioning",
          "running",
          "stopped",
        ]),
      )
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

  app.post<{ Params: { id: string } }>(
    "/api/requests/:id/stop",
    async (req, reply) => {
      const session = await requireApprovedUser(req, reply);
      if (!session) return;
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const stopped = await runtime.runPromise(
        Effect.either(stopInstance({ id: params.data.id, user: session.user })),
      );
      return Either.match(stopped, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: (row) => toServerRequest(row),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/requests/:id/start",
    async (req, reply) => {
      const session = await requireApprovedUser(req, reply);
      if (!session) return;
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const started = await runtime.runPromise(
        Effect.either(
          startInstance({ id: params.data.id, user: session.user }),
        ),
      );
      return Either.match(started, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: (row) => toServerRequest(row),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/requests/:id/retry",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      if (session.user.role !== "operator") {
        return sendErr(reply, 403, "operator role required", "forbidden");
      }
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const retried = await runtime.runPromise(
        Effect.either(retryProvision({ id: params.data.id })),
      );
      return Either.match(retried, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: (row) => toServerRequest(row),
      });
    },
  );

  // Credentials flow: the instance one-time password for root SSH (read once,
  // then cleared). Desktop VNC uses its own persistent desktop_password via
  // the DesktopSession gate + same-origin proxy below — never this endpoint.
  app.get<{ Params: { id: string } }>(
    "/api/requests/:id/credentials",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const credentials = await runtime.runPromise(
        Effect.either(
          readInstancePassword({ id: params.data.id, user: session.user }),
        ),
      );
      return Either.match(credentials, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: ({ password }) => ({ password }) satisfies CredentialsResponse,
      });
    },
  );

  // Desktop session: same-origin KasmVNC canvas URL for the panel iframe.
  // Panel session cookie is the only gate; the guest secret travels only in
  // the URL hash fragment (never sent to the server, never logged). The
  // proxy injects Basic auth toward the guest from desktop_password, and the
  // hash carries Kasm's `password` (RFB autoconnect, no login form) plus the
  // `path` override so the client WebSocket targets the same-origin proxy
  // prefix instead of /websockify at the panel root. Basic auth alone would
  // only unlock the HTTP page, not the VNC session. Owner/operator +
  // running + desktop row present, else 404 (no oracle).
  app.get<{ Params: { id: string } }>(
    "/api/requests/:id/desktop",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      const params = IdParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const gated = await runtime.runPromise(
        Effect.either(
          readDesktopSession({ id: params.data.id, user: session.user }),
        ),
      );
      return Either.match(gated, {
        onLeft: (e) => sendDomainError(reply, e),
        onRight: ({ desktopUser, desktopPassword }) => {
          const base = `/api/requests/${params.data.id}/desktop/session/`;
          const wsPath =
            `api/requests/${params.data.id}/desktop/session/websockify`;
          return {
            url:
              `${base}#password=${encodeURIComponent(desktopPassword)}` +
              `&autoconnect=true&resize=scale&path=${encodeURIComponent(wsPath)}`,
            desktopUser,
          } satisfies DesktopSessionResponse;
        },
      });
    },
  );

  // Desktop session proxy: same-origin KasmVNC canvas. Panel cookie gates;
  // the server injects Basic auth toward the guest from desktop_password.
  // One wildcard handler serves the page plus every asset: subpath (after
  // /desktop/session/) maps 1:1 onto the guest root, query passes through.
  // GET streams the guest response with COOP/COEP stripped (Kasm's
  // require-corp + same-origin would blank the same-origin iframe). The
  // canvas secret travels only in the page URL hash fragment (never sent
  // to the server, never logged); the hash carries Kasm's `password` (RFB
  // autoconnect, no login form) plus the `path` override so the client
  // WebSocket targets this same prefix instead of /websockify at root.
  // Basic auth alone would only unlock the HTTP page, not the VNC session.
  app.get<{ Params: { id: string; "*": string } }>(
    "/api/requests/:id/desktop/session/*",
    async (req, reply) => {
      const session = await resolveSession(req);
      if (!session)
        return sendErr(reply, 401, "session required", "unauthorized");
      const params = IdWildcardParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 400, zodMessage(params.error.issues), "invalid");
      const gated = await runtime.runPromise(
        Effect.either(
          readDesktopSession({ id: params.data.id, user: session.user }),
        ),
      );
      if (Either.isLeft(gated)) return sendDomainError(reply, gated.left);
      const { desktopUser, backendHost, backendPort, desktopPassword } =
        gated.right;
      const rawUrl = req.raw.url ?? "/";
      const prefix = `/api/requests/${params.data.id}/desktop/session/`;
      const pathStart = rawUrl.indexOf(prefix);
      const after =
        pathStart >= 0 ? rawUrl.slice(pathStart + prefix.length) : "";
      const target = `https://${backendHost}:${backendPort}/${after}`;
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(`${desktopUser}:${desktopPassword}`).toString(
                "base64",
              ),
          },
          // Kasm serves a self-signed snakeoil cert; Traefik already uses
          // insecureSkipVerify for the same backend.
          // @ts-expect-error Bun-only TLS option (node types lack it).
          tls: { rejectUnauthorized: false },
        });
      } catch {
        return sendErr(reply, 502, "desktop unreachable", "internal");
      }
      const contentType = upstream.headers.get("content-type");
      if (contentType) reply.header("content-type", contentType);
      const cache = upstream.headers.get("cache-control");
      if (cache) reply.header("cache-control", cache);
      // COOP/COEP stripped by omission: Kasm's require-corp + same-origin
      // would blank the same-origin iframe. No framing headers upstream.
      const rawBody = Buffer.from(await upstream.arrayBuffer());
      // Anchor relative Kasm asset URLs (dist/, vendor/, app/) to this
      // prefix: without this the page resolves them against /desktop/ and
      // every bundle 404s. Only for HTML; binaries pass through.
      if (
        upstream.status === 200 &&
        (contentType ?? "").includes("text/html")
      ) {
        const html = rawBody
          .toString("utf8")
          .replace(
            /<html([^>]*)>/,
            `<html$1><head><base href="/api/requests/${params.data.id}/desktop/session/">`,
          );
        return reply.code(upstream.status).send(html);
      }
      return reply.code(upstream.status).send(rawBody);
    },
  );
  // The browser opens wss://<panel>/api/requests/:id/desktop/session/
  // websockify (per the `path` hash override); the panel cookie gates the
  // upgrade and the server re-authenticates toward the guest with Basic
  // auth from desktop_password over a TLS backend that skips verify
  // (same snakeoil cert Traefik already trusts blindly). Frames relay
  // both directions; either side closing tears the pair down.
  // Node http server 'upgrade' args are (req, socket, head) — req first.
  app.server.on("upgrade", (...rawArgs: unknown[]) => {
      const upgradeReq = rawArgs[0] as {
        url?: unknown;
        headers: Record<string, unknown>;
      };
      const socket = rawArgs[1] as import("node:net").Socket;
      const getHeader = (name: string): string | undefined => {
        const value = upgradeReq?.headers?.[name];
        return typeof value === "string" ? value : undefined;
      };
      if (!upgradeReq || typeof upgradeReq !== "object") {
        socket.destroy();
        return;
      }
      void (async () => {
      try {
        const rawUrl = typeof upgradeReq.url === "string" ? upgradeReq.url : "";
        const match = rawUrl.match(
          /^\/api\/requests\/([0-9a-f-]{36})\/desktop\/session\/(.*)$/,
        );
        if (!match?.[1]) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        const requestId = match[1];
        const after = match[2] ?? "";
        const session = await resolveSessionCookie(getHeader("cookie"));
        if (!session) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        const gated = await runtime.runPromise(
          Effect.either(
            readDesktopSession({ id: requestId, user: session.user }),
          ),
        );
        if (Either.isLeft(gated)) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        const { desktopUser, backendHost, backendPort, desktopPassword } =
          gated.right;
        const { connect } = tls;
        const basic = Buffer.from(
          `${desktopUser}:${desktopPassword}`,
        ).toString("base64");
        const guestPath = `/${after}`;
        const guest = connect({
          host: backendHost,
          port: backendPort,
          rejectUnauthorized: false,
        });
        await new Promise<void>((resolve, reject) => {
          guest.once("secureConnect", () => resolve());
          guest.once("error", reject);
        });
        const incoming = getHeader("sec-websocket-protocol");
        const protocols =
          typeof incoming === "string" && incoming.length > 0
            ? incoming
            : "binary";
        // KasmVNC's websocket check requires an Origin header (browser
        // always sends one; raw sockets do not). Forward the client's or
        // synthesize the panel origin — either satisfies the check.
        const origin =
          getHeader("origin") ?? getHeader("sec-websocket-origin") ?? "";
        // The client dials the proxy subpath (/desktop/session/websockify);
        // the guest serves the channel at its root — strip the prefix.
        const proxyPrefix = `api/requests/${requestId}/desktop/session/`;
        const guestWsPath = after.startsWith(proxyPrefix)
          ? `/${after.slice(proxyPrefix.length)}`
          : "/websockify";
        guest.write(
          `GET ${guestWsPath} HTTP/1.1\r\n` +
            `Host: ${backendHost}:${backendPort}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${getHeader("sec-websocket-key") ?? ""}\r\n` +
            `Sec-WebSocket-Protocol: ${protocols}\r\n` +
            `Sec-WebSocket-Version: ${getHeader("sec-websocket-version") ?? "13"}\r\n` +
            (origin.length > 0 ? `Origin: ${origin}\r\n` : "") +
            `Authorization: Basic ${basic}\r\n\r\n`,
        );
        let head2 = await new Promise<string>((resolve, reject) => {
          let acc = "";
          const onData = (chunk: Buffer) => {
            acc += chunk.toString("latin1");
            if (acc.includes("\r\n\r\n")) {
              guest.off("data", onData);
              resolve(acc);
            }
          };
          guest.on("data", onData);
          guest.once("error", reject);
        });
        if (!head2.startsWith("HTTP/1.1 101")) {
          socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          socket.destroy();
          guest.destroy();
          return;
        }
        const extraHeaderEnd = head2.indexOf("\r\n\r\n") + 4;
        const extraLatin1 = head2.slice(extraHeaderEnd);
        const acceptKey = await sha1Base64(
          `${getHeader("sec-websocket-key") ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        );
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
            `Sec-WebSocket-Protocol: ${protocols.split(",")[0]?.trim() ?? "binary"}\r\n\r\n`,
        );
        // The guest's 101 and its first RFB frame arrive in one TLS packet:
        // the header reader above already consumed those bytes into a JS
        // string. Re-emit them as binary (latin1, not utf8) so the 0x82
        // WS frame + "RFB 003.008" version survive the relay.
        if (extraLatin1.length > 0) {
          socket.write(Buffer.from(extraLatin1, "latin1"));
        }
        socket.pipe(guest);
        guest.pipe(socket);
        socket.once("close", () => guest.destroy());
        guest.once("close", () => socket.destroy());
      } catch {
        try {
          socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          // Socket already gone; nothing to report.
        }
        socket.destroy();
      }
      })();
  });

  app.addHook("onClose", async () => {
    await runtime.dispose();
    if (handle) await handle.sql.end();
  });

  return app;
}
