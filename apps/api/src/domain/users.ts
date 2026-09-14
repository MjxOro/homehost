import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { AccountStatus, TechnicalLevel } from "@homehost/shared";
import { DatabaseTag } from "./Database.js";
import { DbFailure, InvalidTransition } from "./errors.js";

export type { AccountStatus, TechnicalLevel };

export class UserNotFound extends Data.TaggedError("UserNotFound")<{}> {}

export interface UserRow {
  id: string;
  name: string;
  role: string;
  tier: string;
  email: string | null;
  provider: string | null;
  providerSub: string | null;
  accountStatus: AccountStatus;
  technicalLevel: TechnicalLevel | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

const USER_COLUMNS = sql`id, name, role, tier, email, provider, provider_sub, account_status, technical_level, reviewed_by, reviewed_at`;

type RawRow = Record<string, unknown>;

function toUserRow(r: RawRow): UserRow {
  return {
    id: r["id"] as string,
    name: r["name"] as string,
    role: r["role"] as string,
    tier: r["tier"] as string,
    email: r["email"] as string | null,
    provider: r["provider"] as string | null,
    providerSub: r["provider_sub"] as string | null,
    accountStatus: r["account_status"] as AccountStatus,
    technicalLevel: r["technical_level"] as TechnicalLevel | null,
    reviewedBy: r["reviewed_by"] as string | null,
    reviewedAt: r["reviewed_at"] as Date | null,
  };
}

function rowsOf(result: unknown): RawRow[] {
  return result as RawRow[];
}

// Keyset pagination over the text PK: ids are opaque, so the cursor is just
// the last seen id, base64url-encoded like /api/activity's cursor scheme.

export interface ListUsersInput {
  status?: AccountStatus;
  limit?: number;
  cursor?: string;
}

export interface UsersPage {
  users: UserRow[];
  hasMore: boolean;
  nextCursor: string | null;
}
const USERS_PAGE_DEFAULT = 20;
const USERS_PAGE_MAX = 100;

function encodeUsersCursor(id: string): string {
  // Cursor shape mirrors /api/activity: last seen key, base64url-encoded.
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeUsersCursor(cursor: string): string | null {
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export const listUsers = (
  input: ListUsersInput,
): Effect.Effect<UsersPage, InvalidTransition | DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const limit = Math.min(
      Math.max(input.limit ?? USERS_PAGE_DEFAULT, 1),
      USERS_PAGE_MAX,
    );
    let cursorId: string | null = null;
    if (input.cursor !== undefined) {
      const decoded = decodeUsersCursor(input.cursor);
      if (!decoded) {
        return yield* new InvalidTransition({ message: "invalid cursor" });
      }
      cursorId = decoded;
    }
    const db = yield* DatabaseTag;
    // Read-only: no row lock needed. The status filter and the keyset bound
    // compose, so paging a filtered queue cannot skip or repeat rows.
    const rows = yield* Effect.tryPromise({
      try: () => {
        const conditions: SQL[] = [];
        if (input.status !== undefined) {
          conditions.push(sql`account_status = ${input.status}`);
        }
        if (cursorId !== null) {
          conditions.push(sql`id > ${cursorId}`);
        }
        const where =
          conditions.length > 0
            ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
            : sql``;
        return db.execute(sql`
          SELECT ${USER_COLUMNS} FROM users ${where}
          ORDER BY id ASC LIMIT ${limit + 1}
        `);
      },
      catch: (cause) => new DbFailure({ cause }),
    });
    const all = rowsOf(rows).map(toUserRow);
    const hasMore = all.length > limit;
    const users = all.slice(0, limit);
    const last = users[users.length - 1];
    return {
      users,
      hasMore,
      nextCursor: hasMore && last ? encodeUsersCursor(last.id) : null,
    };
  });

interface ModerateInput {
  id: string;
  actorId: string;
  /** Current statuses this transition may start from; anything else is illegal. */
  allowedFrom: readonly AccountStatus[];
  /** SET assignments fragment, e.g. status + reviewer stamp. */
  assign: (now: Date) => SQL;
  illegalMessage: string;
  auditAction: string;
  auditDetail: string | null;
}

type ModerateOutcome =
  | { ok: true; row: UserRow }
  | { ok: false; reason: "missing" | "state" };

function moderateUser(
  input: ModerateInput,
): Effect.Effect<
  UserRow,
  UserNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> {
  return Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: ModerateOutcome = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // Existence and current status are rechecked under row lock, so a
          // losing concurrent moderation gets 404/conflict, never a lost update.
          await tx.execute(
            sql`SELECT 1 FROM users WHERE id = ${input.id} FOR UPDATE`,
          );
          const found = rowsOf(
            await tx.execute(
              sql`SELECT ${USER_COLUMNS} FROM users WHERE id = ${input.id} LIMIT 1`,
            ),
          );
          const current = found[0];
          if (!current) {
            return { ok: false as const, reason: "missing" as const };
          }
          if (
            !input.allowedFrom.includes(
              current["account_status"] as AccountStatus,
            )
          ) {
            return { ok: false as const, reason: "state" as const };
          }
          const now = new Date();
          const updated = rowsOf(
            await tx.execute(sql`
              UPDATE users SET ${input.assign(now)}
              WHERE id = ${input.id}
              RETURNING ${USER_COLUMNS}
            `),
          );
          // Audit row shape is per Contract
          // (moderation_actions(id, target_user_id, actor_id, action, detail,
          // created_at), migration 0009, landed). Written with raw SQL in the
          // same transaction so the audit row rolls back with the mutation.
          await tx.execute(sql`
            INSERT INTO moderation_actions
              (id, target_user_id, actor_id, action, detail, created_at)
            VALUES (${randomUUID()}, ${input.id}, ${input.actorId}, ${input.auditAction}, ${input.auditDetail}, ${now})
          `);
          return { ok: true as const, row: toUserRow(updated[0]) };
        }),
      catch: (cause) => new DbFailure({ cause }),
    });
    if (!outcome.ok) {
      return yield* outcome.reason === "missing"
        ? new UserNotFound()
        : new InvalidTransition({ message: input.illegalMessage });
    }
    return outcome.row;
  });
}

// Approval sets status and classification atomically: exactly one audit row
// (action 'approve', detail = technical level), never a status row plus a
// separate classification row.
export const approveUser = (
  id: string,
  actorId: string,
  technicalLevel: TechnicalLevel,
): Effect.Effect<
  UserRow,
  UserNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> =>
  moderateUser({
    id,
    actorId,
    allowedFrom: ["pending"],
    illegalMessage: "only pending users can be approved",
    assign: (now) =>
      // The technicalOnly plan gate reads the legacy tier column, so approval
      // syncs it with the classification ('non_technical' maps to tier
      // 'nontechnical') in the same UPDATE.
      sql`account_status = 'approved', technical_level = ${technicalLevel}, tier = ${technicalLevel === "technical" ? "technical" : "nontechnical"}, reviewed_by = ${actorId}, reviewed_at = ${now}`,
    auditAction: "approve",
    auditDetail: technicalLevel,
  });

export const rejectUser = (
  id: string,
  actorId: string,
  reason?: string,
): Effect.Effect<
  UserRow,
  UserNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> =>
  moderateUser({
    id,
    actorId,
    allowedFrom: ["pending"],
    illegalMessage: "only pending users can be rejected",
    assign: (now) =>
      sql`account_status = 'rejected', reviewed_by = ${actorId}, reviewed_at = ${now}`,
    auditAction: "reject",
    auditDetail: reason ?? null,
  });

// Classification is an attribute set, not a status transition: it is allowed
// for pending and approved users, and illegal for rejected/suspended ones.
// It sets technical_level and syncs the legacy tier column; the audit row
// carries actor and time.
export const setClassification = (
  id: string,
  actorId: string,
  technicalLevel: TechnicalLevel,
): Effect.Effect<
  UserRow,
  UserNotFound | InvalidTransition | DbFailure,
  DatabaseTag
> =>
  moderateUser({
    id,
    actorId,
    allowedFrom: ["pending", "approved"],
    illegalMessage: "only pending or approved users can be classified",
    // Keeps the legacy tier gate consistent when an approved user is
    // re-classified (same 'non_technical' -> 'nontechnical' mapping as approve).
    assign: () => sql`technical_level = ${technicalLevel}, tier = ${technicalLevel === "technical" ? "technical" : "nontechnical"}`,
    auditAction: "classification",
    auditDetail: technicalLevel,
  });
