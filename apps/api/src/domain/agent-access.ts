import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { Data, Effect } from "effect";
import {
  ACCESS_TOKEN_MAX_ACTIVE,
  ACCESS_TOKEN_PREFIX,
  EXEC_CONCURRENCY_PER_TOKEN,
  type CreateAccessTokenInput,
  type PortalUser,
} from "@homehost/shared";
import type { Database } from "../db/client.js";
import * as schema from "../db/schema.js";
import { DatabaseTag } from "./Database.js";
import { DbFailure } from "./errors.js";

export type AccessTokenRow = typeof schema.accessTokens.$inferSelect;
export type MachineRow = typeof schema.serverRequests.$inferSelect;
export type ExecRow = typeof schema.machineExecs.$inferSelect;

export class AccessTokenNotFound extends Data.TaggedError(
  "AccessTokenNotFound",
)<{}> {}
export class AccessTokenLimit extends Data.TaggedError(
  "AccessTokenLimit",
)<{}> {}
export class MachineNotVisible extends Data.TaggedError(
  "MachineNotVisible",
)<{}> {}
export class AmbiguousMachine extends Data.TaggedError(
  "AmbiguousMachine",
)<{}> {}
export class ExecBusy extends Data.TaggedError("ExecBusy")<{}> {}

export interface AuthenticatedToken {
  token: AccessTokenRow;
  user: PortalUser;
}

const withDb = <A>(run: (db: Database) => Promise<A>) =>
  Effect.flatMap(DatabaseTag, (db) =>
    Effect.tryPromise({
      try: () => run(db),
      catch: (cause) => new DbFailure({ cause }),
    }),
  );

export const hashAccessToken = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

export const createAccessToken = (input: {
  user: PortalUser;
  body: CreateAccessTokenInput;
  now: Date;
}): Effect.Effect<
  { row: AccessTokenRow; secret: string },
  AccessTokenLimit | MachineNotVisible | DbFailure,
  DatabaseTag
> =>
  Effect.flatMap(
    withDb((db) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM users WHERE id = ${input.user.id} FOR UPDATE`,
        );
        const [active] = await tx
          .select({ n: count() })
          .from(schema.accessTokens)
          .where(
            and(
              eq(schema.accessTokens.userId, input.user.id),
              isNull(schema.accessTokens.revokedAt),
              gt(schema.accessTokens.expiresAt, input.now),
            ),
          );
        if ((active?.n ?? 0) >= ACCESS_TOKEN_MAX_ACTIVE)
          return { ok: false as const, error: new AccessTokenLimit() };
        const machineIds = input.body.machineIds
          ? [...new Set(input.body.machineIds)]
          : null;
        if (machineIds) {
          const owned = await tx
            .select({ id: schema.serverRequests.id })
            .from(schema.serverRequests)
            .where(
              and(
                eq(schema.serverRequests.ownerId, input.user.id),
                ne(schema.serverRequests.status, "deleted"),
                inArray(schema.serverRequests.id, machineIds),
              ),
            );
          if (owned.length !== machineIds.length)
            return { ok: false as const, error: new MachineNotVisible() };
        }
        const secret =
          ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
        const [row] = await tx
          .insert(schema.accessTokens)
          .values({
            userId: input.user.id,
            name: input.body.name,
            tokenHash: hashAccessToken(secret),
            tokenHint: secret.slice(-4),
            scopes: input.body.scopes,
            machineIds,
            expiresAt: new Date(
              input.now.getTime() + input.body.expiresInDays * 86_400_000,
            ),
          })
          .returning();
        return { ok: true as const, row: row!, secret };
      }),
    ),
    (outcome) =>
      outcome.ok
        ? Effect.succeed({ row: outcome.row, secret: outcome.secret })
        : Effect.fail(outcome.error),
  );

export const listAccessTokens = (
  userId: string,
): Effect.Effect<AccessTokenRow[], DbFailure, DatabaseTag> =>
  withDb((db) =>
    db
      .select()
      .from(schema.accessTokens)
      .where(eq(schema.accessTokens.userId, userId))
      .orderBy(desc(schema.accessTokens.createdAt))
      .limit(100),
  );

export const revokeAccessToken = (input: {
  userId: string;
  id: string;
  now: Date;
}): Effect.Effect<
  AccessTokenRow,
  AccessTokenNotFound | DbFailure,
  DatabaseTag
> =>
  Effect.flatMap(
    withDb((db) =>
      db
        .update(schema.accessTokens)
        .set({
          revokedAt: sql`COALESCE(${schema.accessTokens.revokedAt}, ${input.now.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(schema.accessTokens.id, input.id),
            eq(schema.accessTokens.userId, input.userId),
          ),
        )
        .returning(),
    ),
    ([row]) =>
      row ? Effect.succeed(row) : Effect.fail(new AccessTokenNotFound()),
  );

/**
 * Every bearer call re-checks revocation, expiry and the owner's approval,
 * so revoking a token or suspending its owner applies to the next call.
 */
export const authenticateAccessToken = (input: {
  secret: string;
  now: Date;
}): Effect.Effect<AuthenticatedToken | null, DbFailure, DatabaseTag> =>
  withDb(async (db) => {
    const [found] = await db
      .select()
      .from(schema.accessTokens)
      .innerJoin(schema.users, eq(schema.accessTokens.userId, schema.users.id))
      .where(eq(schema.accessTokens.tokenHash, hashAccessToken(input.secret)))
      .limit(1);
    if (!found) return null;
    const { access_tokens: token, users: u } = found;
    if (token.revokedAt || token.expiresAt.getTime() <= input.now.getTime())
      return null;
    if (u.role !== "operator" && u.accountStatus !== "approved") return null;
    await db
      .update(schema.accessTokens)
      .set({ lastUsedAt: input.now })
      .where(eq(schema.accessTokens.id, token.id));
    return {
      token,
      user: {
        id: u.id,
        name: u.name,
        role: u.role as PortalUser["role"],
        tier: u.tier as PortalUser["tier"],
        email: u.email,
      },
    };
  });

export const listVisibleMachines = (
  token: AccessTokenRow,
): Effect.Effect<MachineRow[], DbFailure, DatabaseTag> =>
  withDb((db) =>
    db
      .select()
      .from(schema.serverRequests)
      .where(
        and(
          eq(schema.serverRequests.ownerId, token.userId),
          ne(schema.serverRequests.status, "deleted"),
          token.machineIds
            ? inArray(schema.serverRequests.id, token.machineIds)
            : undefined,
        ),
      )
      .orderBy(asc(schema.serverRequests.createdAt)),
  );

export const resolveMachine = (
  token: AccessTokenRow,
  ref: string,
): Effect.Effect<
  MachineRow,
  MachineNotVisible | AmbiguousMachine | DbFailure,
  DatabaseTag
> =>
  Effect.flatMap(
    listVisibleMachines(token),
    (
      machines,
    ): Effect.Effect<MachineRow, MachineNotVisible | AmbiguousMachine> => {
      const byId = machines.find((m) => m.id === ref);
      if (byId) return Effect.succeed(byId);
      const byName = machines.filter((m) => m.name === ref);
      if (byName.length > 1) return Effect.fail(new AmbiguousMachine());
      const [only] = byName;
      return only ? Effect.succeed(only) : Effect.fail(new MachineNotVisible());
    },
  );

export type ExecOperation =
  | { op: "command"; command: string; cwd: string | null }
  | { op: "read_file"; path: string }
  | { op: "write_file"; path: string; input: Buffer; fileMode: number | null };

/**
 * Locks the token row while counting its active operations, so concurrent
 * calls cannot exceed the per-token cap. The id is chosen by the caller so it
 * can subscribe to the completion notification before the row exists.
 */
export const enqueueExec = (input: {
  id: string;
  token: AccessTokenRow;
  machine: MachineRow;
  operation: ExecOperation;
  maxBytes: number;
  timeoutMs: number;
}): Effect.Effect<string, ExecBusy | DbFailure, DatabaseTag> =>
  Effect.flatMap(
    withDb((db) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM access_tokens WHERE id = ${input.token.id} FOR UPDATE`,
        );
        const [active] = await tx
          .select({ n: count() })
          .from(schema.machineExecs)
          .where(
            and(
              eq(schema.machineExecs.tokenId, input.token.id),
              inArray(schema.machineExecs.status, ["queued", "running"]),
            ),
          );
        if ((active?.n ?? 0) >= EXEC_CONCURRENCY_PER_TOKEN) return false;
        const operation = input.operation;
        await tx.insert(schema.machineExecs).values({
          id: input.id,
          requestId: input.machine.id,
          userId: input.token.userId,
          tokenId: input.token.id,
          op: operation.op,
          command: operation.op === "command" ? operation.command : null,
          cwd: operation.op === "command" ? operation.cwd : null,
          path: operation.op === "command" ? null : operation.path,
          input: operation.op === "write_file" ? operation.input : null,
          fileMode: operation.op === "write_file" ? operation.fileMode : null,
          maxBytes: input.maxBytes,
          timeoutMs: input.timeoutMs,
        });
        return true;
      }),
    ),
    (queued) =>
      queued ? Effect.succeed(input.id) : Effect.fail(new ExecBusy()),
  );

export const newExecId = () => randomUUID();

export const readExec = (
  id: string,
): Effect.Effect<ExecRow | null, DbFailure, DatabaseTag> =>
  withDb(async (db) => {
    const [row] = await db
      .select()
      .from(schema.machineExecs)
      .where(eq(schema.machineExecs.id, id))
      .limit(1);
    return row ?? null;
  });

/** A row no worker picked up in time fails here, so a late worker skips it. */
export const expireQueuedExec = (
  id: string,
): Effect.Effect<void, DbFailure, DatabaseTag> =>
  withDb(async (db) => {
    await db
      .update(schema.machineExecs)
      .set({
        status: "failed",
        error: "expired",
        input: null,
        finishedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.machineExecs.id, id),
          eq(schema.machineExecs.status, "queued"),
        ),
      );
  });
