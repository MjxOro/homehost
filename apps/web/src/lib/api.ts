import type {
  ApprovalResponse,
  DashboardResponse,
  Plan,
  ServerRequest,
  SessionResponse,
} from "@homehost/shared";

/**
 * Error surfaced by every API call. `status` is the HTTP status, or 0 when the
 * request never reached the API (network/DNS/proxy failure). `code` mirrors the
 * server `code` field ("invalid" | "unauthorized" | "forbidden" | "not_found" |
 * "conflict" | "quota" | ...), or "network" for transport failures.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

export const api = {
  getSession: (): Promise<SessionResponse> => request("/api/session"),

  switchPersona: (personaId: string): Promise<SessionResponse> =>
    request("/api/demo/session", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ personaId }),
    }),

  logout: (): Promise<{ ok: true }> =>
    request("/api/session", { method: "DELETE" }),

  getPlans: (): Promise<Plan[]> => request("/api/plans"),

  getDashboard: (): Promise<DashboardResponse> => request("/api/dashboard"),

  createRequest: (input: {
    name: string;
    planId: string;
  }): Promise<ServerRequest> =>
    request("/api/requests", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),

  cancelRequest: (id: string): Promise<{ ok: true }> =>
    request(`/api/requests/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getApprovals: (): Promise<ApprovalResponse> => request("/api/approvals"),

  decide: (
    id: string,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<ServerRequest> =>
    request(`/api/requests/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ decision, reason }),
    }),
};
