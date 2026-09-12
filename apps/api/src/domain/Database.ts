import { Context, Layer } from "effect";
import type { Database } from "../db/client.js";

export class DatabaseTag extends Context.Tag("Homehost/Database")<
  DatabaseTag,
  Database
>() {}

/** Live-value layer factory: boot and smoke tests supply the Drizzle handle. */
export const DatabaseLive = (db: Database): Layer.Layer<DatabaseTag> =>
  Layer.succeed(DatabaseTag, db);
