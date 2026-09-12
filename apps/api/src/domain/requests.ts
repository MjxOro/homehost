import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { TIER_QUOTAS, toSubdomain } from "@homehost/shared";
import type { Plan, PortalUser } from "@homehost/shared";
import * as schema from "../db/schema.js";
import { DatabaseTag } from "./Database.js";
import {
  DbFailure,
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
          const inserted = await tx
            .insert(schema.serverRequests)
            .values({
              id,
              ownerId: input.user.id,
              ownerName: input.user.name,
              name: input.name,
              planId: input.plan.id,
              status: "pending_approval",
              subdomain: toSubdomain(
                input.name,
                input.user.id,
                input.baseDomain,
                id,
              ),
              cpu: input.plan.cpu,
              memoryMb: input.plan.memoryMb,
              diskGb: input.plan.diskGb,
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
          return { ok: true as const };
        }),
      catch: (cause) => new DbFailure({ cause }),
    });
    if (!outcome.ok) return yield* new RequestNotFound();
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
