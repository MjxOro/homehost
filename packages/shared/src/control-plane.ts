export type TrustTier = "untrusted" | "trusted";
export type UserRole = "member" | "operator";
export type RequestStatus =
  "pending_approval" | "approved" | "rejected" | "deleted";

export interface Quota {
  servers: number;
  cpu: number;
  memoryMb: number;
  diskGb: number;
}

export interface PortalUser {
  id: string;
  name: string;
  role: UserRole;
  tier: TrustTier;
}

export interface DemoPersona extends PortalUser {}

export interface SessionResponse {
  mode: "showcase";
  user: PortalUser | null;
  personas: DemoPersona[];
}

export interface ServerRequest {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  planId: string;
  status: RequestStatus;
  subdomain: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  createdAt: string;
  updatedAt: string;
  decisionReason: string | null;
}

export interface ActivityEvent {
  id: string;
  requestId: string;
  actorName: string;
  action: "requested" | "approved" | "rejected" | "deleted";
  serverName: string;
  createdAt: string;
  detail: string | null;
}

export interface DashboardResponse {
  user: PortalUser;
  quota: Quota;
  usage: Quota;
  requests: ServerRequest[];
  activity: ActivityEvent[];
}

export interface ApprovalResponse {
  requests: ServerRequest[];
}

export interface ApiError {
  error: string;
  code: string;
}

export const TIER_QUOTAS: Record<TrustTier, Quota> = {
  untrusted: { servers: 1, cpu: 2, memoryMb: 2048, diskGb: 20 },
  trusted: { servers: 5, cpu: 16, memoryMb: 16384, diskGb: 200 },
};
