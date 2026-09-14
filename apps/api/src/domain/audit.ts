import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { DatabaseTag } from "./Database.js";
import { DbFailure } from "./errors.js";

export type ModerationActionKind = "approve" | "reject" | "classification";

export interface AuditRow {
  id: string;
  targetUserId: string;
  actorId: string;
  action: ModerationActionKind;
  detail: string | null;
  createdAt: Date;
}

export interface RecordActionInput {
  targetUserId: string;
  actorId: string;
  action: ModerationActionKind;
  detail?: string | null;
}

/** Decoded keyset position; routes encode it opaquely like /api/activity. */
export interface AuditCursor {
  createdAt: string;
  id: string;
}

export interface ListActionsInput {
  targetUserId?: string;
  limit?: number;
  cursor?: AuditCursor;
}

export interface ActionsPage {
  actions: AuditRow[];
  hasMore: boolean;
  nextCursor: AuditCursor | null;
}

const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;

function toAuditRow(row: Record<string, unknown>): AuditRow {
  return {
    id: String(row.id),
    targetUserId: String(row.target_user_id),
    actorId: String(row.actor_id),
    action: row.action as ModerationActionKind,
    detail: (row.detail as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

const SELECT_COLUMNS =
  sql`id, target_user_id, actor_id, action, detail, created_at`;

/** Append-only audit write; callers run it in the same transaction as the change. */
export const recordAction = (
  input: RecordActionInput,
): Effect.Effect<AuditRow, DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db.execute(
          sql`INSERT INTO moderation_actions (target_user_id, actor_id, action, detail)
              VALUES (${input.targetUserId}, ${input.actorId}, ${input.action}, ${input.detail ?? null})
              RETURNING ${SELECT_COLUMNS}`,
        ),
      catch: (cause) => new DbFailure({ cause }),
    });
    return toAuditRow((rows as Array<Record<string, unknown>>)[0]);
  });

/** Newest-first keyset listing, mirroring /api/activity pagination. */
export const listActions = (
  input: ListActionsInput,
): Effect.Effect<ActionsPage, DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const limit = Math.min(
      Math.max(input.limit ?? PAGE_DEFAULT, 1),
      PAGE_MAX,
    );
    const filters = [];
    if (input.targetUserId !== undefined) {
      filters.push(sql`target_user_id = ${input.targetUserId}`);
    }
    if (input.cursor !== undefined) {
      filters.push(
        sql`(created_at, id) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`,
      );
    }
    const where =
      filters.length > 0
        ? sql`WHERE ${sql.join(filters, sql` AND `)}`
        : sql``;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db.execute(
          sql`SELECT ${SELECT_COLUMNS} FROM moderation_actions
              ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
        ),
      catch: (cause) => new DbFailure({ cause }),
    });
    const all = (rows as Array<Record<string, unknown>>).map(toAuditRow);
    const hasMore = all.length > limit;
    const actions = all.slice(0, limit);
    const last = actions[actions.length - 1];
    return {
      actions,
      hasMore,
      nextCursor: hasMore && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
    };
  });
