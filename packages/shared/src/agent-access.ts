import { z } from "zod";
import type { RequestStatus } from "./control-plane.js";

export const ACCESS_TOKEN_PREFIX = "hht_";
export const ACCESS_TOKEN_PATTERN = /^hht_[A-Za-z0-9_-]{43}$/;
export const ACCESS_SCOPES = [
  "machines:read",
  "machines:exec",
  "machines:power",
] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];
export const ACCESS_TOKEN_MAX_DAYS = 90;
export const ACCESS_TOKEN_MAX_ACTIVE = 20;
export const ACCESS_TOKEN_MAX_MACHINES = 50;

export const EXEC_TIMEOUT_DEFAULT_S = 60;
export const EXEC_TIMEOUT_MAX_S = 600;
export const EXEC_COMMAND_MAX_CHARS = 16_384;
export const EXEC_OUTPUT_MAX_BYTES = 256 * 1024;
export const EXEC_CONCURRENCY_PER_TOKEN = 4;
export const FILE_MAX_BYTES = 4 * 1024 * 1024;
export const FILE_READ_DEFAULT_BYTES = 1024 * 1024;

export const CreateAccessTokenBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    scopes: z
      .array(z.enum(ACCESS_SCOPES))
      .min(1)
      .max(ACCESS_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, "duplicate scope"),
    /** Null grants every machine the owner has now or later. */
    machineIds: z
      .array(z.string().uuid())
      .min(1)
      .max(ACCESS_TOKEN_MAX_MACHINES)
      .nullable(),
    expiresInDays: z.number().int().min(1).max(ACCESS_TOKEN_MAX_DAYS),
  })
  .strict();
export type CreateAccessTokenInput = z.infer<typeof CreateAccessTokenBody>;

export interface AccessToken {
  id: string;
  name: string;
  /** Last four characters of the secret, for recognising it in a list. */
  hint: string;
  scopes: AccessScope[];
  machineIds: string[] | null;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AccessTokenListResponse {
  tokens: AccessToken[];
}

/** POST /api/access-tokens: the secret is returned exactly once. */
export interface CreatedAccessToken {
  token: AccessToken;
  secret: string;
}

export type MachineKind = "container" | "vm";
export type MachineCapability = "exec" | "files" | "power" | "desktop";

/** A machine as agents see it; addressed by id or by its unique name. */
export interface AgentMachine {
  id: string;
  name: string;
  kind: MachineKind;
  planId: string;
  status: RequestStatus;
  hostname: string;
  capabilities: MachineCapability[];
}

export interface AgentMachineListResponse {
  machines: AgentMachine[];
}

const AbsolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => p.startsWith("/") && !p.includes("\0"),
    "absolute path required",
  );

export const ExecBody = z
  .object({
    command: z.string().min(1).max(EXEC_COMMAND_MAX_CHARS),
    cwd: AbsolutePath.optional(),
    timeoutSeconds: z.number().int().min(1).max(EXEC_TIMEOUT_MAX_S).optional(),
  })
  .strict();
export type ExecInput = z.infer<typeof ExecBody>;

export interface ExecResult {
  id: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export const ReadFileBody = z
  .object({
    path: AbsolutePath,
    maxBytes: z.number().int().min(1).max(FILE_MAX_BYTES).optional(),
  })
  .strict();
export type ReadFileInput = z.infer<typeof ReadFileBody>;

export interface FileReadResult {
  path: string;
  /** utf8 when the bytes are valid UTF-8, otherwise base64. */
  encoding: "utf8" | "base64";
  content: string;
  bytes: number;
  truncated: boolean;
}

export const WriteFileBody = z
  .object({
    path: AbsolutePath,
    content: z.string().max(Math.ceil((FILE_MAX_BYTES * 4) / 3) + 4),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    mode: z.number().int().min(0).max(0o7777).optional(),
  })
  .strict();
export type WriteFileInput = z.input<typeof WriteFileBody>;

export interface FileWriteResult {
  path: string;
  bytes: number;
}

export const PowerBody = z
  .object({ action: z.enum(["start", "stop"]) })
  .strict();
export type PowerInput = z.infer<typeof PowerBody>;
