import {
  check,
  index,
  integer,
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
      sql`${t.action} IN ('requested','approved','rejected','deleted','provisioning','running','stopped','provision_failed')`,
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
      sql`${t.action} IN ('provision','teardown','stop','start')`,
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
