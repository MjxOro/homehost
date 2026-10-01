// Ledger vocabularies shared by the API, web and bench. Types and constants only:
// this module ships in the web bundle, so no `node:` imports (hashing lives in the API).

export const LEDGER_REASONS = [
  "purchase",
  "usage",
  "refund",
  "grant",
  "adjustment",
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const AGENT_RUN_KINDS = [
  "site_build",
  "site_edit",
  "site_import",
  "concierge",
  "agent_chat",
  "bench",
] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

export const AGENT_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const USAGE_PURPOSES = ["prod", "bench", "dev"] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

export const LLM_CALL_STATUSES = ["ok", "error"] as const;
export type LlmCallStatus = (typeof LLM_CALL_STATUSES)[number];
