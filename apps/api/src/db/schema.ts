import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
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
  },
  (t) => [
    check("users_role_check", sql`${t.role} IN ('member','operator')`),
    check("users_tier_check", sql`${t.tier} IN ('untrusted','trusted')`),
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
    cpu: integer("cpu").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    diskGb: integer("disk_gb").notNull(),
    decisionReason: text("decision_reason"),
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
      sql`${t.status} IN ('pending_approval','approved','rejected','deleted')`,
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
      sql`${t.action} IN ('requested','approved','rejected','deleted')`,
    ),
    index("activity_events_request_id_idx").on(t.requestId),
    index("activity_events_created_at_idx").on(t.createdAt),
  ],
);
