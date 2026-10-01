import {
  bigint,
  char,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    tier: text("tier").notNull(),
    email: text("email").unique(),
    provider: text("provider"),
    providerSub: text("provider_sub"),
    accountStatus: text("account_status").notNull().default("pending"),
    technicalLevel: text("technical_level"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    check("users_role_check", sql`${t.role} IN ('member','operator')`),
    check("users_tier_check", sql`${t.tier} IN ('nontechnical','technical')`),
    check(
      "users_account_status_check",
      sql`${t.accountStatus} IN ('pending','approved','rejected','suspended')`,
    ),
    check(
      "users_technical_level_check",
      sql`${t.technicalLevel} IS NULL OR ${t.technicalLevel} IN ('technical','non_technical')`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const serverRequests = pgTable(
  "server_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    ownerName: text("owner_name").notNull(),
    name: text("name").notNull(),
    planId: text("plan_id").notNull(),
    status: text("status").notNull().default("pending_approval"),
    subdomain: text("subdomain").notNull().unique(),
    instanceName: text("instance_name").unique(),
    cpu: integer("cpu").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    diskGb: integer("disk_gb").notNull(),
    decisionReason: text("decision_reason"),
    ipv4: text("ipv4"),
    sshPubkey: text("ssh_pubkey"),
    instancePassword: text("instance_password"),
    sshPort: integer("ssh_port"),
    ipv6: text("ipv6"),
    desktopEnv: text("desktop_env"),
    desktopHostname: text("desktop_hostname").unique(),
    desktopPort: integer("desktop_port"),
    // Persistent KasmVNC secret: the ONLY desktop credential. The panel never
    // sees it (proxy injects Basic auth from this column). Survives refresh;
    // never cleared on read (unlike instance_password, the one-read root OTP).
    desktopPassword: text("desktop_password"),
    // Setup recipe (migration 0015): NULL recipe = plain Ubuntu, and then
    // setup_status is 'none'. eula_accepted_at records the owner's license
    // acceptance at request time.
    recipeId: text("recipe_id"),
    setupStatus: text("setup_status").notNull().default("none"),
    setupStep: text("setup_step"),
    setupError: text("setup_error"),
    eulaAcceptedAt: timestamp("eula_accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "server_requests_status_check",
      sql`${t.status} IN ('pending_approval','approved','provisioning','running','stopped','rejected','deleted')`,
    ),
    check("server_requests_cpu_check", sql`${t.cpu} > 0`),
    check("server_requests_memory_check", sql`${t.memoryMb} > 0`),
    check("server_requests_disk_check", sql`${t.diskGb} > 0`),
    check(
      "server_requests_recipe_id_check",
      sql`${t.recipeId} IS NULL OR ${t.recipeId} IN ('node','python','docker','code_server','minecraft_java','minecraft_bedrock','valheim')`,
    ),
    check(
      "server_requests_setup_status_check",
      sql`${t.setupStatus} IN ('none','pending','running','done','failed')`,
    ),
    check(
      "server_requests_setup_recipe_check",
      sql`(${t.recipeId} IS NULL) = (${t.setupStatus} = 'none')`,
    ),
    check(
      "server_requests_setup_step_check",
      sql`${t.setupStep} IS NULL OR ${t.setupStep} IN ('update_packages','install_java','download_minecraft','configure_minecraft','install_node','install_python','install_docker','start_service','wait_ready')`,
    ),
    index("server_requests_owner_id_idx").on(t.ownerId),
    index("server_requests_status_idx").on(t.status),
    index("server_requests_owner_status_idx").on(t.ownerId, t.status),
    index("server_requests_created_at_idx").on(t.createdAt),
  ],
);

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => serverRequests.id, { onDelete: "cascade" }),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    serverName: text("server_name").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "activity_events_action_check",
      sql`${t.action} IN ('requested','approved','rejected','deleted','provisioning','running','stopped','provision_failed','setup_started','setup_done','setup_failed')`,
    ),
    index("activity_events_request_id_idx").on(t.requestId),
    index("activity_events_created_at_idx").on(t.createdAt),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    tier: text("tier").notNull().default("nontechnical"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("invites_email_idx").on(t.email)],
);

export const provisionJobs = pgTable(
  "provision_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => serverRequests.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "provision_jobs_action_check",
      sql`${t.action} IN ('provision','teardown','stop','start','setup')`,
    ),
    check(
      "provision_jobs_status_check",
      sql`${t.status} IN ('queued','leased','done','failed')`,
    ),
    check("provision_jobs_attempts_check", sql`${t.attempts} >= 0`),
    uniqueIndex("provision_jobs_active_unique")
      .on(t.requestId, t.action)
      .where(sql`${t.status} IN ('queued','leased')`),
    index("provision_jobs_status_idx").on(t.status),
    index("provision_jobs_request_id_idx").on(t.requestId),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => users.id),
    kind: text("kind").notNull(),
    purpose: text("purpose").notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    check(
      "agent_runs_kind_check",
      sql`${t.kind} IN ('site_build','site_edit','site_import','concierge','bench')`,
    ),
    check(
      "agent_runs_purpose_check",
      sql`${t.purpose} IN ('prod','bench','dev')`,
    ),
    check(
      "agent_runs_status_check",
      sql`${t.status} IN ('running','succeeded','failed','cancelled')`,
    ),
    index("agent_runs_user_id_started_at_idx").on(t.userId, t.startedAt),
  ],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
    userId: text("user_id").references(() => users.id),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    promptHash: text("prompt_hash").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costMicroUsd: bigint("cost_micro_usd", { mode: "bigint" }).notNull(),
    priceTableVersion: text("price_table_version").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "llm_calls_purpose_check",
      sql`${t.purpose} IN ('prod','bench','dev')`,
    ),
    check(
      "llm_calls_prompt_hash_check",
      sql`${t.promptHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("llm_calls_input_tokens_check", sql`${t.inputTokens} >= 0`),
    check("llm_calls_output_tokens_check", sql`${t.outputTokens} >= 0`),
    check(
      "llm_calls_cached_input_tokens_check",
      sql`${t.cachedInputTokens} >= 0`,
    ),
    check(
      "llm_calls_cache_write_tokens_check",
      sql`${t.cacheWriteTokens} >= 0`,
    ),
    check("llm_calls_cost_micro_usd_check", sql`${t.costMicroUsd} >= 0`),
    check("llm_calls_latency_ms_check", sql`${t.latencyMs} >= 0`),
    check("llm_calls_status_check", sql`${t.status} IN ('ok','error')`),
    index("llm_calls_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("llm_calls_agent_run_id_idx").on(t.agentRunId),
    uniqueIndex("llm_calls_provider_request_unique")
      .on(t.provider, t.providerRequestId)
      .where(sql`${t.providerRequestId} IS NOT NULL`),
  ],
);

// Append-only, hash-chained; see docs/ledger.md. Rows are written only through
// domain/ledger.ts, which owns the hash formula and the append lock.
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    delta: bigint("delta", { mode: "bigint" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    confirmId: uuid("confirm_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    hash: char("hash", { length: 64 }).notNull().unique(),
  },
  (t) => [
    check("credit_ledger_delta_check", sql`${t.delta} <> 0`),
    check("credit_ledger_balance_after_check", sql`${t.balanceAfter} >= 0`),
    check(
      "credit_ledger_reason_check",
      sql`${t.reason} IN ('purchase','usage','refund','grant','adjustment')`,
    ),
    check(
      "credit_ledger_prev_hash_check",
      sql`${t.prevHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("credit_ledger_hash_check", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    index("credit_ledger_user_id_id_idx").on(t.userId, t.id),
  ],
);

// Historical IDs intentionally have no foreign keys: history survives even
// physical deletion/truncation of its request and owner. Contact is snapshotted.
export const ipAssignments = pgTable(
  "ip_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id").notNull(),
    userId: text("user_id").notNull(),
    ownerName: text("owner_name").notNull(),
    ownerEmail: text("owner_email"),
    address: inet("address").notNull(),
    subdomain: text("subdomain").notNull(),
    prefix: text("prefix").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "ip_assignments_release_check",
      sql`${t.releasedAt} IS NULL OR ${t.releasedAt} >= ${t.assignedAt}`,
    ),
    check(
      "ip_assignments_host_check",
      sql`masklen(${t.address}) = CASE family(${t.address}) WHEN 6 THEN 128 ELSE 32 END`,
    ),
    uniqueIndex("ip_assignments_open_address_unique")
      .on(t.address)
      .where(sql`${t.releasedAt} IS NULL`),
    index("ip_assignments_address_assigned_at_idx").on(t.address, t.assignedAt),
    index("ip_assignments_request_id_idx").on(t.requestId),
  ],
);
