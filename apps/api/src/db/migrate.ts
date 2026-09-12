import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Ledger-tracked migrations: each file runs once, inside its own transaction,
// under a session advisory lock so concurrent boots cannot double-apply.
// Seed rows live inside the migration, so they are inserted once, not every boot.
const ADVISORY_KEY = 721913;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);
const sql = postgres(url, { max: 1 });
try {
  await sql`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    const applied = await sql`SELECT filename FROM schema_migrations`;
    const done = new Set(applied.map((r) => String(r.filename)));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    if (files.length === 0) {
      console.error(`no migrations found in ${dir}`);
      process.exit(1);
    }
    for (const f of files) {
      if (done.has(f)) {
        console.log(`skipped ${f} (already applied)`);
        continue;
      }
      const text = await readFile(path.join(dir, f), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${f})`;
      });
      console.log(`applied ${f}`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
  }
} finally {
  await sql.end();
}
