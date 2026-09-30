import { sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { DatabaseTag } from "./Database.js";
import { DbFailure } from "./errors.js";

export class InvalidAddress extends Data.TaggedError("InvalidAddress")<{}> {}
export class InvalidLookupTime extends Data.TaggedError(
  "InvalidLookupTime",
)<{}> {}

export interface IpAssignmentRow {
  id: string;
  requestId: string;
  userId: string;
  ownerName: string;
  /** Owner's email when the address was assigned, retained after account removal. */
  ownerEmail: string | null;
  address: string;
  subdomain: string;
  /** Current request hostname, null if the live request has been removed. */
  requestSubdomain: string | null;
  prefix: string;
  assignedAt: Date;
  releasedAt: Date | null;
}

function postgresCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object") return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  return "cause" in cause ? postgresCode(cause.cause) : undefined;
}

/** A host address, parsed/canonicalized by Postgres; windows are [start, end). */
export const lookupAddress = (
  address: string,
  at?: string | Date,
): Effect.Effect<
  IpAssignmentRow[],
  InvalidAddress | InvalidLookupTime | DbFailure,
  DatabaseTag
> =>
  Effect.gen(function* () {
    if (
      typeof address !== "string" ||
      address.trim().length === 0 ||
      address.length > 128
    )
      return yield* new InvalidAddress();
    let instant: string | undefined;
    if (at !== undefined) {
      const parsed = at instanceof Date ? at : new Date(at);
      if (!Number.isFinite(parsed.getTime()))
        return yield* new InvalidLookupTime();
      // Keep ISO string precision: Postgres stores microseconds, while Date
      // rounds to milliseconds and could move a lookup across a release edge.
      instant = at instanceof Date ? parsed.toISOString() : at;
    }
    const db = yield* DatabaseTag;
    // Parse separately so invalid inet input is rejected even for an empty
    // ledger, and do not accidentally treat a /64 network as one host.
    const parsed = yield* Effect.tryPromise({
      try: () =>
        db.execute(sql`SELECT host(${address.trim()}::inet) AS address,
        masklen(${address.trim()}::inet) AS mask, family(${address.trim()}::inet) AS family`),
      catch: (cause) =>
        postgresCode(cause) === "22P02"
          ? new InvalidAddress()
          : new DbFailure({ cause }),
    });
    const normalized = (parsed as Array<Record<string, unknown>>)[0]!;
    if (
      Number(normalized.mask) !== (Number(normalized.family) === 6 ? 128 : 32)
    )
      return yield* new InvalidAddress();
    const host = String(normalized.address);
    const columns = sql`a.id, a.request_id, a.user_id, COALESCE(a.owner_name, u.name) AS owner_name,
      a.owner_email, host(a.address) AS address, a.subdomain, r.subdomain AS request_subdomain,
      a.prefix, a.assigned_at, a.released_at`;
    const join = sql`LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN server_requests r ON r.id = a.request_id`;
    const query =
      instant !== undefined
        ? sql`SELECT ${columns} FROM ip_assignments a ${join}
          WHERE a.address = ${host}::inet AND a.assigned_at <= ${instant}::timestamptz
            AND ${instant}::timestamptz < COALESCE(a.released_at, 'infinity'::timestamptz)
          ORDER BY a.assigned_at DESC, a.id DESC`
        : sql`SELECT ${columns} FROM (
          SELECT * FROM ip_assignments WHERE address = ${host}::inet AND released_at IS NULL
          UNION ALL
          (SELECT * FROM ip_assignments WHERE address = ${host}::inet AND released_at IS NOT NULL
           ORDER BY assigned_at DESC, id DESC LIMIT 20)
        ) a ${join}
        ORDER BY (a.released_at IS NULL) DESC, a.assigned_at DESC, a.id DESC`;
    const result = yield* Effect.tryPromise({
      try: () => db.execute(query),
      catch: (cause) =>
        ["22007", "22008"].includes(postgresCode(cause) ?? "")
          ? new InvalidLookupTime()
          : new DbFailure({ cause }),
    });
    return (result as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      requestId: String(row.request_id),
      userId: String(row.user_id),
      ownerName: String(row.owner_name),
      ownerEmail: row.owner_email as string | null,
      address: String(row.address),
      subdomain: String(row.subdomain),
      requestSubdomain: row.request_subdomain as string | null,
      prefix: String(row.prefix),
      assignedAt: new Date(row.assigned_at as string | Date),
      releasedAt:
        row.released_at === null
          ? null
          : new Date(row.released_at as string | Date),
    }));
  });
