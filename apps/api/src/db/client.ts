import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
}

export function createDb(url: string): DbHandle {
  const sql = postgres(url, { max: 10 });
  const db: Database = drizzle(sql, { schema });
  return { db, sql };
}
