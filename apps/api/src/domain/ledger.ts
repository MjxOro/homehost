import { createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import type {
  AgentRunKind,
  AgentRunStatus,
  LedgerReason,
  LlmCallStatus,
  UsagePurpose,
} from "@homehost/shared";
import type { DbTransaction } from "../db/client.js";
import * as schema from "../db/schema.js";
import { DatabaseTag } from "./Database.js";
import { DbFailure } from "./errors.js";

export class InsufficientCredits extends Data.TaggedError(
  "InsufficientCredits",
)<{
  readonly balance: bigint;
  readonly requested: bigint;
}> {}

export class InvalidUsage extends Data.TaggedError("InvalidUsage")<{
  readonly message: string;
}> {}

export class DuplicateLlmCall extends Data.TaggedError("DuplicateLlmCall")<{}> {}

export class AgentRunNotRunning extends Data.TaggedError(
  "AgentRunNotRunning",
)<{}> {}

/** Distinct from migrate.ts's session lock (721913); one global chain, one lock. */
export const LEDGER_LOCK_KEY = 721914;

export const GENESIS_HASH = "0".repeat(64);

export type AgentRunRow = typeof schema.agentRuns.$inferSelect;
export type LlmCallRow = typeof schema.llmCalls.$inferSelect;

export interface LedgerRow {
  id: bigint;
  userId: string;
  delta: bigint;
  balanceAfter: bigint;
  reason: LedgerReason;
  refType: string | null;
  refId: string | null;
  confirmId: string | null;
  createdAt: Date;
  prevHash: string;
  hash: string;
}

type HashedFields = Pick<
  LedgerRow,
  | "userId"
  | "delta"
  | "balanceAfter"
  | "reason"
  | "refType"
  | "refId"
  | "confirmId"
  | "createdAt"
>;

/** Fixed-order array: no key-order ambiguity. Amounts are decimal strings. */
export function canonicalLedgerRow(r: HashedFields): string {
  return JSON.stringify([
    r.userId,
    r.delta.toString(),
    r.balanceAfter.toString(),
    r.reason,
    r.refType ?? null,
    r.refId ?? null,
    r.confirmId ?? null,
    r.createdAt.toISOString(),
  ]);
}

export function ledgerRowHash(prevHash: string, r: HashedFields): string {
  return createHash("sha256")
    .update(`${prevHash}\n${canonicalLedgerRow(r)}`)
    .digest("hex");
}

// created_at is read back as the exact ISO-8601 ms string the app wrote, so the
// canonical row recomputes identically regardless of driver timestamp parsing.
// Order by the qualified table column: a bare `id` would bind to the text alias.
const LEDGER_COLUMNS = sql`id::text AS id, user_id, delta::text AS delta,
  balance_after::text AS balance_after, reason, ref_type, ref_id,
  confirm_id::text AS confirm_id,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  prev_hash, hash`;

function toLedgerRow(row: Record<string, unknown>): LedgerRow {
  return {
    id: BigInt(row.id as string),
    userId: String(row.user_id),
    delta: BigInt(row.delta as string),
    balanceAfter: BigInt(row.balance_after as string),
    reason: row.reason as LedgerReason,
    refType: (row.ref_type as string | null) ?? null,
    refId: (row.ref_id as string | null) ?? null,
    confirmId: (row.confirm_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return result as Array<Record<string, unknown>>;
}

export interface AppendCreditInput {
  userId: string;
  delta: bigint;
  reason: LedgerReason;
  refType?: string;
  refId?: string;
  confirmId?: string;
}

export type AppendOutcome =
  | { ok: true; row: LedgerRow }
  | { ok: false; balance: bigint };

/**
 * Append inside a caller-owned transaction, so "spend credits for this action"
 * can commit atomically with the action. The advisory xact lock serializes every
 * append globally and is released with the caller's commit or rollback. An
 * overdraft returns `{ ok: false }` and writes nothing, leaving the caller's
 * transaction usable.
 */
export async function appendCreditInTx(
  tx: DbTransaction,
  input: AppendCreditInput,
): Promise<AppendOutcome> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
  const head = rowsOf(
    await tx.execute(
      sql`SELECT hash FROM credit_ledger ORDER BY id DESC LIMIT 1`,
    ),
  )[0];
  const prevHash = head ? String(head.hash) : GENESIS_HASH;
  const last = rowsOf(
    await tx.execute(
      sql`SELECT balance_after::text AS balance_after FROM credit_ledger
          WHERE user_id = ${input.userId} ORDER BY id DESC LIMIT 1`,
    ),
  )[0];
  const balance = last ? BigInt(last.balance_after as string) : 0n;
  const balanceAfter = balance + input.delta;
  if (balanceAfter < 0n) return { ok: false, balance };
  const fields: HashedFields = {
    userId: input.userId,
    delta: input.delta,
    balanceAfter,
    reason: input.reason,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    confirmId: input.confirmId ?? null,
    // Millisecond precision (Date), written as the same ISO string that is hashed.
    createdAt: new Date(),
  };
  const hash = ledgerRowHash(prevHash, fields);
  const inserted = rowsOf(
    await tx.execute(
      sql`INSERT INTO credit_ledger
            (user_id, delta, balance_after, reason, ref_type, ref_id, confirm_id,
             created_at, prev_hash, hash)
          VALUES (${fields.userId}, ${fields.delta.toString()}::bigint,
                  ${fields.balanceAfter.toString()}::bigint, ${fields.reason},
                  ${fields.refType}, ${fields.refId}, ${fields.confirmId}::uuid,
                  ${fields.createdAt.toISOString()}::timestamptz, ${prevHash}, ${hash})
          RETURNING ${LEDGER_COLUMNS}`,
    ),
  )[0];
  return { ok: true, row: toLedgerRow(inserted as Record<string, unknown>) };
}

export const appendCredit = (
  input: AppendCreditInput,
): Effect.Effect<LedgerRow, InsufficientCredits | DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const outcome: AppendOutcome = yield* Effect.tryPromise({
      try: () => db.transaction((tx) => appendCreditInTx(tx, input)),
      catch: (cause) => new DbFailure({ cause }),
    });
    if (!outcome.ok) {
      return yield* new InsufficientCredits({
        balance: outcome.balance,
        requested: input.delta,
      });
    }
    return outcome.row;
  });

export const getBalance = (
  userId: string,
): Effect.Effect<bigint, DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db.execute(
          sql`SELECT balance_after::text AS balance_after FROM credit_ledger
              WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1`,
        ),
      catch: (cause) => new DbFailure({ cause }),
    });
    const row = rowsOf(rows)[0];
    return row ? BigInt(row.balance_after as string) : 0n;
  });

export type VerifyResult =
  | { ok: true; rows: number; head: string }
  | {
      ok: false;
      rows: number;
      brokenAtId: bigint;
      reason: "prev_hash" | "hash" | "balance";
    };

const VERIFY_PAGE = 1000;

/** Walks the chain by id ascending, recomputing every hash and per-user balance. */
export const verifyLedger = (): Effect.Effect<
  VerifyResult,
  DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    let prevHash = GENESIS_HASH;
    let rows = 0;
    let afterId = 0n;
    const balances = new Map<string, bigint>();
    for (;;) {
      const page = yield* Effect.tryPromise({
        try: () =>
          db.execute(
            sql`SELECT ${LEDGER_COLUMNS} FROM credit_ledger
                WHERE id > ${afterId.toString()}::bigint
                ORDER BY credit_ledger.id ASC LIMIT ${VERIFY_PAGE}`,
          ),
        catch: (cause) => new DbFailure({ cause }),
      });
      const batch = rowsOf(page).map(toLedgerRow);
      for (const row of batch) {
        const broken = (reason: "prev_hash" | "hash" | "balance"): VerifyResult => ({
          ok: false,
          rows,
          brokenAtId: row.id,
          reason,
        });
        if (row.prevHash !== prevHash) return broken("prev_hash");
        if (row.hash !== ledgerRowHash(row.prevHash, row)) return broken("hash");
        const expected = (balances.get(row.userId) ?? 0n) + row.delta;
        if (row.balanceAfter !== expected) return broken("balance");
        balances.set(row.userId, expected);
        prevHash = row.hash;
        rows += 1;
        afterId = row.id;
      }
      if (batch.length < VERIFY_PAGE) break;
    }
    return { ok: true as const, rows, head: prevHash };
  });

export interface StartAgentRunInput {
  userId?: string | null;
  kind: AgentRunKind;
  purpose: UsagePurpose;
  refType?: string;
  refId?: string;
  metadata?: Record<string, unknown>;
}

export const startAgentRun = (
  input: StartAgentRunInput,
): Effect.Effect<AgentRunRow, DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const inserted = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(schema.agentRuns)
          .values({
            userId: input.userId ?? null,
            kind: input.kind,
            purpose: input.purpose,
            refType: input.refType ?? null,
            refId: input.refId ?? null,
            metadata: input.metadata ?? {},
          })
          .returning(),
      catch: (cause) => new DbFailure({ cause }),
    });
    return inserted[0]!;
  });

export const finishAgentRun = (
  id: string,
  status: Exclude<AgentRunStatus, "running">,
): Effect.Effect<AgentRunRow, AgentRunNotRunning | DbFailure, DatabaseTag> =>
  Effect.gen(function* () {
    const db = yield* DatabaseTag;
    const updated = yield* Effect.tryPromise({
      try: () =>
        db
          .update(schema.agentRuns)
          .set({ status, finishedAt: new Date() })
          .where(
            and(
              eq(schema.agentRuns.id, id),
              eq(schema.agentRuns.status, "running"),
            ),
          )
          .returning(),
      catch: (cause) => new DbFailure({ cause }),
    });
    const row = updated[0];
    if (!row) return yield* new AgentRunNotRunning();
    return row;
  });

export interface RecordLlmCallInput {
  agentRunId?: string | null;
  userId?: string | null;
  purpose: UsagePurpose;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Integer micro-dollars. Never a float. */
  costMicroUsd: bigint;
  priceTableVersion: string;
  latencyMs: number;
  status: LlmCallStatus;
  errorCode?: string | null;
}

const INT4_MAX = 2_147_483_647;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

function validateLlmCall(input: RecordLlmCallInput): string | null {
  const ints = {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    latencyMs: input.latencyMs,
  };
  for (const [name, v] of Object.entries(ints)) {
    if (!Number.isInteger(v) || v < 0 || v > INT4_MAX) {
      return `${name} must be an integer between 0 and ${INT4_MAX}`;
    }
  }
  if (
    typeof input.costMicroUsd !== "bigint" ||
    input.costMicroUsd < 0n ||
    input.costMicroUsd > BIGINT_MAX
  ) {
    return "costMicroUsd must be a non-negative bigint";
  }
  if (!/^[0-9a-f]{64}$/.test(input.promptHash)) {
    return "promptHash must be 64 lowercase hex characters";
  }
  return null;
}

function isUniqueViolation(e: unknown): boolean {
  // Drizzle wraps driver errors; the SQLSTATE lives on the cause.
  const code = (x: unknown): unknown =>
    typeof x === "object" && x !== null && "code" in x ? x.code : undefined;
  const cause =
    typeof e === "object" && e !== null && "cause" in e ? e.cause : undefined;
  return code(e) === "23505" || code(cause) === "23505";
}

export const recordLlmCall = (
  input: RecordLlmCallInput,
): Effect.Effect<
  LlmCallRow,
  InvalidUsage | DuplicateLlmCall | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    const invalid = validateLlmCall(input);
    if (invalid !== null) return yield* new InvalidUsage({ message: invalid });
    const db = yield* DatabaseTag;
    const inserted = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(schema.llmCalls)
          .values({
            agentRunId: input.agentRunId ?? null,
            userId: input.userId ?? null,
            purpose: input.purpose,
            provider: input.provider,
            model: input.model,
            providerRequestId: input.providerRequestId ?? null,
            promptHash: input.promptHash,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cachedInputTokens: input.cachedInputTokens,
            cacheWriteTokens: input.cacheWriteTokens,
            costMicroUsd: input.costMicroUsd,
            priceTableVersion: input.priceTableVersion,
            latencyMs: input.latencyMs,
            status: input.status,
            errorCode: input.errorCode ?? null,
          })
          .returning(),
      catch: (cause): DuplicateLlmCall | DbFailure =>
        isUniqueViolation(cause)
          ? new DuplicateLlmCall()
          : new DbFailure({ cause }),
    });
    return inserted[0]!;
  });
