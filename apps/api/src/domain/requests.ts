import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { PLANS, TIER_QUOTAS, toDesktopHostname, toSubdomain } from "@homehost/shared";
import type { Plan, PortalUser, ProvisionAction } from "@homehost/shared";
import * as schema from "../db/schema.js";
import { DatabaseTag } from "./Database.js";
import {
  DbFailure,
  InvalidTransition,
  QuotaExceeded,
  RequestNotFound,
  SubdomainTaken,
  TransitionConflict,
} from "./errors.js";

export type RequestRow = typeof schema.serverRequests.$inferSelect;

const ACTIVE_STATUSES = ["pending_approval", "approved"] as const;

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && e.code === "23505"
  );
}

export interface CreateInput {
  user: PortalUser;
  name: string;
  plan: Plan;
  baseDomain: string;
  sshPubkey?: string;
}

type CreateOutcome =
  { ok: true; row: RequestRow } | { ok: false; reason: "quota" };

export const createRequest = (
  input: CreateInput,
): Effect.Effect<
  RequestRow,
  QuotaExceeded | SubdomainTaken | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: CreateOutcome = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // Serialize quota admission per owner; concurrent creates cannot exceed quota.
          await tx.execute(
            sql`SELECT 1 FROM users WHERE id = ${input.user.id} FOR UPDATE`,
          );
          const held = await tx
            .select()
            .from(schema.serverRequests)
            .where(
              and(
                eq(schema.serverRequests.ownerId, input.user.id),
                inArray(schema.serverRequests.status, [...ACTIVE_STATUSES]),
              ),
            );
          const used = { servers: 0, cpu: 0, memoryMb: 0, diskGb: 0 };
          for (const r of held) {
            used.servers += 1;
            used.cpu += r.cpu;
            used.memoryMb += r.memoryMb;
            used.diskGb += r.diskGb;
          }
          const quota = TIER_QUOTAS[input.user.tier];
          if (
            used.servers + 1 > quota.servers ||
            used.cpu + input.plan.cpu > quota.cpu ||
            used.memoryMb + input.plan.memoryMb > quota.memoryMb ||
            used.diskGb + input.plan.diskGb > quota.diskGb
          ) {
            return { ok: false as const, reason: "quota" as const };
          }
          const id = randomUUID();
          const now = new Date();
          const subdomain = toSubdomain(
            input.name,
            input.user.id,
            input.baseDomain,
            id,
          );
          // Desktop GUI plans carry their KasmVNC stack on the plan; headless
          // plans store NULLs. desktopPort snapshots plan.desktop.kasmPort so
          // the edge route template can target the backend without a lookup.
          const desktop = input.plan.desktop;
          const desktopHostname = desktop ? toDesktopHostname(subdomain) : null;
          const inserted = await tx
            .insert(schema.serverRequests)
            .values({
              id,
              ownerId: input.user.id,
              ownerName: input.user.name,
              name: input.name,
              planId: input.plan.id,
              status: "pending_approval",
              subdomain,
              sshPubkey: input.sshPubkey ?? null,
              cpu: input.plan.cpu,
              memoryMb: input.plan.memoryMb,
              diskGb: input.plan.diskGb,
              desktopEnv: desktop ? desktop.env : null,
              desktopHostname,
              desktopPort: desktop ? desktop.kasmPort : null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          await tx.insert(schema.activityEvents).values({
            requestId: id,
            actorName: input.user.name,
            action: "requested",
            serverName: input.name,
          });
          return { ok: true as const, row: inserted[0] };
        }),
      catch: (cause): SubdomainTaken | DbFailure =>
        isUniqueViolation(cause)
          ? new SubdomainTaken()
          : new DbFailure({ cause }),
    });
    if (!outcome.ok) return yield* new QuotaExceeded();
    return outcome.row;
  });

export interface CancelInput {
  id: string;
  user: PortalUser;
}

export const cancelRequest = (
  input: CancelInput,
): Effect.Effect<void, RequestNotFound | DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    // Existence, ownership and non-deleted are rechecked under row lock inside the
    // transaction, so a losing concurrent cancellation gets 404, never a duplicate event.
    const outcome: { ok: boolean } = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT 1 FROM users WHERE id = ${input.user.id} FOR UPDATE`,
          );
          await tx.execute(
            sql`SELECT 1 FROM server_requests WHERE id = ${input.id} FOR UPDATE`,
          );
          const found = await tx
            .select()
            .from(schema.serverRequests)
            .where(eq(schema.serverRequests.id, input.id))
            .limit(1);
          const row = found[0];
          // Operator gains no cross-tenant delete; deleted rows stay invisible as 404.
          if (
            !row ||
            row.ownerId !== input.user.id ||
            row.status === "deleted"
          ) {
            return { ok: false as const };
          }
          await tx
            .update(schema.serverRequests)
            .set({ status: "deleted", updatedAt: new Date() })
            .where(eq(schema.serverRequests.id, row.id));
          await tx.insert(schema.activityEvents).values({
            requestId: row.id,
            actorName: input.user.name,
            action: "deleted",
            serverName: row.name,
          });
          // A live instance needs provider teardown; the worker owns the Incus side.
          // The reservation is released now; the partial unique index keeps this to one job.
          if (
            row.instanceName &&
            (row.status === "approved" ||
              row.status === "provisioning" ||
              row.status === "running" ||
              row.status === "stopped")
          ) {
            await tx.insert(schema.provisionJobs).values({
              requestId: row.id,
              action: "teardown",
            });
          }
          return { ok: true as const };
        }),
      catch: (cause) => new DbFailure({ cause }),
    });
    if (!outcome.ok) return yield* new RequestNotFound();
  });

export interface CredentialsInput {
  id: string;
  user: PortalUser;
}

export interface DesktopSessionInput {
  id: string;
  user: PortalUser;
}
export const readInstancePassword = (
  input: CredentialsInput,
): Effect.Effect<
  { password: string | null },
  RequestNotFound | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    // Owner or operator; anything else is 404 with no existence oracle.
    // The row lock serializes concurrent readers: the first takes the secret
    // and clears it, late readers get null exactly like never-set.
    const outcome: { ok: boolean; password: string | null } =
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            const found = await tx
              .select({
                id: schema.serverRequests.id,
                ownerId: schema.serverRequests.ownerId,
              })
              .from(schema.serverRequests)
              .where(eq(schema.serverRequests.id, input.id))
              .limit(1);
            const row = found[0];
            if (
              !row ||
              (row.ownerId !== input.user.id && input.user.role !== "operator")
            ) {
              return { ok: false as const, password: null as string | null };
            }
            await tx.execute(
              sql`SELECT 1 FROM server_requests WHERE id = ${row.id} FOR UPDATE`,
            );
            const secret = await tx
              .select({ password: schema.serverRequests.instancePassword })
              .from(schema.serverRequests)
              .where(eq(schema.serverRequests.id, row.id))
              .limit(1);
            const password = secret[0]?.password ?? null;
            if (password !== null) {
              await tx
                .update(schema.serverRequests)
                .set({ instancePassword: null, updatedAt: new Date() })
                .where(eq(schema.serverRequests.id, row.id));
            }
            return { ok: true as const, password };
          }),
        catch: (cause) => new DbFailure({ cause }),
      });
    if (!outcome.ok) return yield* new RequestNotFound();
    return { password: outcome.password };
  });

/**
 * Desktop session gate: owner/operator + running + desktop row present.
 * Returns the guest backend coordinates for the same-origin VNC proxy.
 * The secret itself never leaves this function — the proxy injects it as
 * Basic auth toward the guest. No read-clear: refresh must keep working.
 */
export const readDesktopSession = (
  input: DesktopSessionInput,
): Effect.Effect<
  {
    desktopUser: string;
    backendHost: string;
    backendPort: number;
    desktopPassword: string;
  },
  RequestNotFound | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: {
      ok: boolean;
      desktopUser: string;
      backendHost: string;
      backendPort: number;
      desktopPassword: string;
    } = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const found = await tx
            .select({
              id: schema.serverRequests.id,
              ownerId: schema.serverRequests.ownerId,
              status: schema.serverRequests.status,
              planId: schema.serverRequests.planId,
              ipv4: schema.serverRequests.ipv4,
              desktopPort: schema.serverRequests.desktopPort,
              desktopPassword: schema.serverRequests.desktopPassword,
            })
            .from(schema.serverRequests)
            .where(eq(schema.serverRequests.id, input.id))
            .limit(1);
          const row = found[0];
          const bad = {
            ok: false as const,
            desktopUser: "",
            backendHost: "",
            backendPort: 0,
            desktopPassword: "",
          };
          if (
            !row ||
            (row.ownerId !== input.user.id && input.user.role !== "operator")
          ) {
            return bad;
          }
          if (row.status !== "running") return bad;
          const plan = PLANS.find((p) => p.id === row.planId);
          const desktopUser = plan?.desktop?.user ?? null;
          if (
            !desktopUser ||
            !row.ipv4 ||
            row.desktopPort === null ||
            !row.desktopPassword
          ) {
            return bad;
          }
          return {
            ok: true as const,
            desktopUser,
            backendHost: row.ipv4,
            backendPort: row.desktopPort,
            desktopPassword: row.desktopPassword,
          };
        }),
      catch: (cause) => new DbFailure({ cause }),
    });
    if (!outcome.ok) return yield* new RequestNotFound();
    return {
      desktopUser: outcome.desktopUser,
      backendHost: outcome.backendHost,
      backendPort: outcome.backendPort,
      desktopPassword: outcome.desktopPassword,
    };
  });

export interface DecideInput {
  id: string;
  actorName: string;
  decision: "approve" | "reject";
  reason: string | null;
}

type DecideOutcome =
  { ok: true; row: RequestRow } | { ok: false; reason: "missing" | "conflict" };
export const decideRequest = (
  input: DecideInput,
): Effect.Effect<
  RequestRow,
  RequestNotFound | TransitionConflict | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: DecideOutcome = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT 1 FROM server_requests WHERE id = ${input.id} FOR UPDATE`,
          );
          const found = await tx
            .select()
            .from(schema.serverRequests)
            .where(eq(schema.serverRequests.id, input.id))
            .limit(1);
          const current = found[0];
          if (!current)
            return { ok: false as const, reason: "missing" as const };
          if (current.status !== "pending_approval") {
            return { ok: false as const, reason: "conflict" as const };
          }
          const status = input.decision === "approve" ? "approved" : "rejected";
          const updated = await tx
            .update(schema.serverRequests)
            .set({
              status,
              decisionReason: input.reason,
              updatedAt: new Date(),
            })
            .where(eq(schema.serverRequests.id, current.id))
            .returning();
          await tx.insert(schema.activityEvents).values({
            requestId: current.id,
            actorName: input.actorName,
            action: input.decision === "approve" ? "approved" : "rejected",
            serverName: current.name,
            detail: input.reason,
          });
          // Approval enqueues provisioning atomically: no approved request
          // exists without a queued provision job, and no job without approval.
          if (input.decision === "approve") {
            await tx.insert(schema.provisionJobs).values({
              requestId: current.id,
              action: "provision",
            });
          }
          return { ok: true as const, row: updated[0] };
        }),
      catch: (cause) => new DbFailure({ cause }),
    });
    if (!outcome.ok) {
      return yield* outcome.reason === "missing"
        ? new RequestNotFound()
        : new TransitionConflict();
    }
    return outcome.row;
  });

export interface InstanceInput {
  id: string;
  user: PortalUser;
}

type PowerOutcome =
  { ok: true; row: RequestRow } | { ok: false; reason: "missing" | "state" };

function powerRequest(
  input: InstanceInput,
  from: "running" | "stopped",
  action: ProvisionAction,
  verb: "stop" | "start",
  past: "stopped" | "started",
): Effect.Effect<
  RequestRow,
  RequestNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> {
  return Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: PowerOutcome = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT 1 FROM server_requests WHERE id = ${input.id} FOR UPDATE`,
          );
          const found = await tx
            .select()
            .from(schema.serverRequests)
            .where(eq(schema.serverRequests.id, input.id))
            .limit(1);
          const row = found[0];
          if (
            !row ||
            row.ownerId !== input.user.id ||
            row.status === "deleted"
          ) {
            return { ok: false as const, reason: "missing" as const };
          }
          if (row.status !== from) {
            return { ok: false as const, reason: "state" as const };
          }
          await tx.insert(schema.provisionJobs).values({
            requestId: row.id,
            action,
          });
          return { ok: true as const, row };
        }),
      catch: (cause): InvalidTransition | DbFailure =>
        isUniqueViolation(cause)
          ? new InvalidTransition({
              message: `a ${verb} job is already queued`,
            })
          : new DbFailure({ cause }),
    });
    if (!outcome.ok) {
      return yield* outcome.reason === "missing"
        ? new RequestNotFound()
        : new InvalidTransition({
            message: `only ${from} requests can be ${past}`,
          });
    }
    return outcome.row;
  });
}

export const stopInstance = (
  input: InstanceInput,
): Effect.Effect<
  RequestRow,
  RequestNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> => powerRequest(input, "running", "stop", "stop", "stopped");

export const startInstance = (
  input: InstanceInput,
): Effect.Effect<
  RequestRow,
  RequestNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> => powerRequest(input, "stopped", "start", "start", "started");

export const retryProvision = (input: {
  id: string;
}): Effect.Effect<
  RequestRow,
  RequestNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: PowerOutcome = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT 1 FROM server_requests WHERE id = ${input.id} FOR UPDATE`,
          );
          const found = await tx
            .select()
            .from(schema.serverRequests)
            .where(eq(schema.serverRequests.id, input.id))
            .limit(1);
          const row = found[0];
          if (!row || row.status === "deleted") {
            return { ok: false as const, reason: "missing" as const };
          }
          // Only failed-then-approved requests are retryable: anything else
          // either has no failure to retry or already has provider state.
          if (row.status !== "approved") {
            return { ok: false as const, reason: "state" as const };
          }
          await tx.insert(schema.provisionJobs).values({
            requestId: row.id,
            action: "provision",
          });
          return { ok: true as const, row };
        }),
      catch: (cause): InvalidTransition | DbFailure =>
        isUniqueViolation(cause)
          ? new InvalidTransition({
              message: "a provision job is already queued",
            })
          : new DbFailure({ cause }),
    });
    if (!outcome.ok) {
      return yield* outcome.reason === "missing"
        ? new RequestNotFound()
        : new InvalidTransition({
            message: "only approved requests can be retried",
          });
    }
    return outcome.row;
  });
