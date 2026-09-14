export type TrustTier = "nontechnical" | "technical";
export type UserRole = "member" | "operator";
export type RequestStatus =
  | "pending_approval"
  | "approved"
  | "provisioning"
  | "running"
  | "stopped"
  | "rejected"
  | "deleted";

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
  /** Login email. Null for seeded showcase personas. */
  email: string | null;
}

export interface DemoPersona extends PortalUser {}

export interface SessionResponse {
  mode: "showcase" | "live";
  user: PortalUser | null;
  personas: DemoPersona[];
  /** Which OAuth providers are configured server-side. */
  providers: { google: boolean; github: boolean };
}

export interface ServerRequest {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  planId: string;
  status: RequestStatus;
  /** Idempotent Incus instance name (req-<uuid8>), set when provisioning starts. */
  instanceName: string | null;
  /** First tenant IPv4, display only. Null until the instance has an address. */
  ipv4: string | null;
  /** Owner attached an SSH public key at request time. The key itself stays server-side. */
  hasSshKey: boolean;
  /** Public IPv6 of the box. Null on v4-only hosts or until addressed. */
  ipv6: string | null;
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
  action:
    | "requested"
    | "approved"
    | "rejected"
    | "deleted"
    | "provisioning"
    | "running"
    | "stopped"
    | "provision_failed";
  serverName: string;
  createdAt: string;
  detail: string | null;
}

export type ProvisionAction = "provision" | "teardown" | "stop" | "start";
export type ProvisionJobStatus = "queued" | "leased" | "done" | "failed";

export interface ProvisionJob {
  id: string;
  requestId: string;
  action: ProvisionAction;
  status: ProvisionJobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface CredentialsResponse {
  /** One-time instance password, or null when key-based, unset, or already shown. */
  password: string | null;
}

export interface ApiError {
  error: string;
  code: string;
}

export const TIER_QUOTAS: Record<TrustTier, Quota> = {
  /** Default: smallest footprint. Every new friend starts here. */
  nontechnical: { servers: 1, cpu: 2, memoryMb: 2048, diskGb: 20 },
  /** IRL technical friends: generous but bounded. Nobody is billed. */
  technical: { servers: 3, cpu: 8, memoryMb: 8192, diskGb: 100 },
};
