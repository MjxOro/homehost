import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

/**
 * Runtime-only operator bootstrap.
 *
 * On boot, every existing *pending* user whose email appears in
 * OPERATOR_EMAILS is promoted to an approved technical operator
 * (account_status, technical_level, role, reviewed_by, reviewed_at).
 * This runs at process start — never inside a migration — so operators
 * seeded by the environment always converge without a data backfill.
 *
 * Guarantees:
 * - UPDATE-only: rows are never inserted, so users that do not exist yet
 *   are untouched (INSERT-safe).
 * - Pending-only: rejected/suspended accounts are never resurrected, even
 *   if their email is allowlisted; only pending rows are modified.
 * - Never demotes: only rows matching the operator allowlist are modified;
 *   every other account keeps its current status/level/role.
 * - Idempotent: the pending-only predicate makes repeated boots true
 *   no-ops, and the RETURNING count reflects rows actually promoted.
 */

type EnvLike = Record<string, string | string[] | undefined>;

/** Parse/normalize the operator allowlist from an env-shaped record. Pure. */
export function resolveOperatorEmails(env: EnvLike): string[] {
  const raw = env.OPERATOR_EMAILS ?? env.operatorEmails;
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const seen = new Set<string>();
  for (const part of parts) {
    const email = part.trim().toLowerCase();
    if (email.length > 0) seen.add(email);
  }
  return [...seen];
}

export interface OperatorBootstrapResult {
  /** Allowlisted emails considered. */
  total: number;
  /** Existing user rows promoted to approved/technical. */
  promoted: number;
}

/**
 * Promote existing operator-email users to approved/technical.
 *
 * @param db Drizzle handle the boot path already holds.
 * @param operatorEmails Allowlist; defaults to OPERATOR_EMAILS from
 *   process.env via {@link resolveOperatorEmails}.
 */
export async function ensureOperatorBootstrap(
  db: Database,
  operatorEmails: string[] = resolveOperatorEmails(process.env),
): Promise<OperatorBootstrapResult> {
  const normalized = [
    ...new Set(
      operatorEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
    ),
  ];
  if (normalized.length === 0) {
    console.info("[bootstrap] no operator emails configured; skipping");
    return { total: 0, promoted: 0 };
  }
  const rows = await db.execute(sql`
    UPDATE "users"
    SET "account_status" = 'approved',
        "technical_level" = 'technical',
        "role" = 'operator',
        "reviewed_by" = 'system:bootstrap',
        "reviewed_at" = now()
    -- Pending-only: non-pending accounts are never resurrected. Re-runs
    -- are true no-ops and the RETURNING count reflects rows promoted.
    WHERE lower("email") IN (${sql.join(
      normalized.map((e) => sql`${e}`),
      sql`, `,
    )})
    AND "account_status" = 'pending'
    RETURNING "id"
  `);
  const promoted = Array.isArray(rows) ? rows.length : 0;
  console.info(
    `[bootstrap] promoted ${promoted} operator account(s) (${normalized.length} email(s) allowlisted)`,
  );
  return { total: normalized.length, promoted };
}
