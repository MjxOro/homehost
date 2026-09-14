/**
 * Admin/operator client for the moderation endpoints. Same session-cookie
 * style as the main web client: `credentials: "same-origin"` on every call,
 * JSON bodies, and `ApiError` (with server `code`) on failure.
 *
 * `AccountStatus` / `TechnicalLevel` are the canonical types from
 * `@homehost/shared`, re-exported here so admin UI code imports one source.
 * Every fetcher resolves to camelCase `AdminUser`, tolerating snake_case
 * wire fields (`account_status`, …) so callers program against a single shape.
 */
import type {
  AccountStatus,
  TechnicalLevel,
} from "@homehost/shared";
import { ApiError } from "./api";

export type { AccountStatus, TechnicalLevel };
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  accountStatus: AccountStatus;
  technicalLevel: TechnicalLevel | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface AdminUsersPage {
  users: AdminUser[];
  nextCursor: string | null;
}

export interface ListAdminUsersParams {
  status?: AccountStatus;
  limit?: number;
  cursor?: string;
}

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(
      0,
      "network",
      "Network error — the API did not respond.",
    );
  }
  if (!response.ok) {
    let message = `Request failed with status ${response.status}.`;
    let code = "unknown";
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        if (typeof record.error === "string" && record.error.length > 0)
          message = record.error;
        if (typeof record.code === "string" && record.code.length > 0)
          code = record.code;
      }
    } catch {
      // Not JSON (or unreadable) — keep the status-based fallback message.
    }
    throw new ApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

const jsonHeaders = { "Content-Type": "application/json" };

function usersQuery(params?: ListAdminUsersParams): string {
  const search = new URLSearchParams();
  if (params?.status) search.set("status", params.status);
  if (params?.limit !== undefined) search.set("limit", String(params.limit));
  if (params?.cursor) search.set("cursor", params.cursor);
  const query = search.toString();
  return query ? `/api/admin/users?${query}` : "/api/admin/users";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Normalize one user payload to camelCase. Accepts snake_case wire fields
 * (`account_status`, `technical_level`, `reviewed_by`, …) as well as
 * camelCase, so the resolved shape never depends on server casing.
 */
function toAdminUser(raw: unknown): AdminUser {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const status = pick("accountStatus", "account_status");
  const level = pick("technicalLevel", "technical_level");
  return {
    id: asString(record.id) ?? "",
    email: asString(record.email) ?? "",
    name: asString(record.name),
    accountStatus: (status ?? "pending") as AccountStatus,
    technicalLevel: (level === "" ? null : (level ?? null)) as TechnicalLevel | null,
    reviewedBy: asString(pick("reviewedBy", "reviewed_by")),
    reviewedAt: asString(pick("reviewedAt", "reviewed_at")),
  };
}

function toAdminUsersPage(raw: unknown): AdminUsersPage {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const users = Array.isArray(record.users) ? record.users.map(toAdminUser) : [];
  const cursor = record.nextCursor ?? record.next_cursor ?? null;
  return {
    users,
    nextCursor: typeof cursor === "string" ? cursor : null,
  };
}

export const adminApi = {
  listUsers: async (
    params?: ListAdminUsersParams,
  ): Promise<AdminUsersPage> =>
    toAdminUsersPage(await adminRequest<unknown>(usersQuery(params))),

  approveUser: async (
    id: string,
    input: { technicalLevel: TechnicalLevel },
  ): Promise<AdminUser> =>
    toAdminUser(
      await adminRequest<unknown>(
        `/api/admin/users/${encodeURIComponent(id)}/approve`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(input),
        },
      ),
    ),

  rejectUser: async (
    id: string,
    input?: { reason?: string },
  ): Promise<AdminUser> =>
    toAdminUser(
      await adminRequest<unknown>(
        `/api/admin/users/${encodeURIComponent(id)}/reject`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(input ?? {}),
        },
      ),
    ),

  updateClassification: async (
    id: string,
    input: { technicalLevel: TechnicalLevel },
  ): Promise<AdminUser> =>
    toAdminUser(
      await adminRequest<unknown>(
        `/api/admin/users/${encodeURIComponent(id)}/classification`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify(input),
        },
      ),
    ),
};
