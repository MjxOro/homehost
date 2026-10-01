import type {
  RecipeId,
  SetupStatus,
  SetupStepId,
} from "./concierge-catalog.js";
import type { DesktopEnv } from "./plans.js";

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

export type AccountStatus = "pending" | "approved" | "rejected" | "suspended";
export type TechnicalLevel = "technical" | "non_technical";

export const TECHNICAL_LEVELS: readonly TechnicalLevel[] = [
  "technical",
  "non_technical",
];

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
  /** Bare desktop host (<label>-vnc.<baseDomain>). Null for non-desktop plans. */
  desktopHostname: string | null;
  /** https://<desktopHostname>. Null for non-desktop plans. */
  desktopUrl: string | null;
  /** GUI desktop baked into the plan's VM. Null for non-desktop plans. */
  desktopEnv: DesktopEnv | null;
  /** Guest username for the desktop login page (hardcoded, per-env). Null for headless. */
  desktopUser: string | null;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  createdAt: string;
  updatedAt: string;
  decisionReason: string | null;
  /** Setup recipe chosen at request time. Null = plain Ubuntu. */
  recipeId: RecipeId | null;
  /** `none` when recipeId is null; otherwise pending → running → done | failed. */
  setupStatus: SetupStatus;
  /** Step the worker is on (or failed at). Null before setup starts. */
  setupStep: SetupStepId | null;
  /** Stable failure code when setupStatus is `failed`, e.g. `download_failed`. */
  setupError: string | null;
  /**
   * Address players type into the game (Minecraft Java: the box hostname; the
   * default port needs no suffix). Null unless a game recipe finished setup.
   */
  gameAddress: string | null;
}

/** Body of POST /api/requests. */
export interface CreateRequestInput {
  /** Link a user-confirmed chat proposal; never supplied by the model. */
  agentProposalId?: string;
  name: string;
  planId: string;
  desktopEnv?: DesktopEnv;
  sshPubkey?: string;
  /** Must be an installable recipe the plan can run. Omit for plain Ubuntu. */
  recipeId?: RecipeId;
  /** Required true when RECIPES[recipeId].eula is set; recorded as a timestamp. */
  eulaAccepted?: boolean;
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
    | "provision_failed"
    | "setup_started"
    | "setup_done"
    | "setup_failed";
  serverName: string;
  createdAt: string;
  detail: string | null;
}

export type ProvisionAction =
  "provision" | "teardown" | "stop" | "start" | "setup";
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

export interface ActivityPageResponse {
  activity: ActivityEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ApprovalResponse {
  requests: ServerRequest[];
}

export interface CredentialsResponse {
  /** One-time instance password, or null when key-based, unset, or already shown. */
  password: string | null;
}

export interface DesktopSessionResponse {
  /**
   * Same-origin URL serving the guest KasmVNC canvas with the panel session
   * cookie as the only gate (no per-request secret in the URL): the API
   * injects Basic auth toward the guest from desktop_password, which never
   * leaves the server. The URL carries Kasm's `?password=` query so the
   * RFB layer autoconnects without a login form; Basic auth alone only
   * unlocks the HTTP page, not the VNC session.
   */
  url: string;
  /** Guest username owning the KasmVNC session (per-env display only). */
  desktopUser: string;
}

export interface ApiError {
  error: string;
  code: string;
}

/** Statuses that hold quota: everything until teardown is queued or the request is rejected. */
export const QUOTA_HOLDING_STATUSES: readonly RequestStatus[] = [
  "pending_approval",
  "approved",
  "provisioning",
  "running",
  "stopped",
];

export const TIER_QUOTAS: Record<TrustTier, Quota> = {
  /** Default: smallest footprint. Every new friend starts here. */
  nontechnical: { servers: 1, cpu: 2, memoryMb: 2048, diskGb: 20 },
  /** IRL technical friends: generous but bounded. Nobody is billed. */
  technical: { servers: 3, cpu: 8, memoryMb: 8192, diskGb: 100 },
};
