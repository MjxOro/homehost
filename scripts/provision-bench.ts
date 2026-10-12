/**
 * Internal provisioning benchmark: how long boxes take to build, per plan and
 * per worker phase. Read-only (the session is forced read-only).
 *
 * Data: server_requests.build_ms (latest provision request -> usable) and the
 * per-phase provision_jobs.timings the worker records (migration 0018).
 * Boxes built before 0018 have build_ms (backfilled) but no phase data.
 *
 * Usage: bun run bench:provision [--env prod|dev] [--db <url>] [--days 30]
 *                                [--recent 15] [--json]
 *   --env   which database: prod (infra/private/worker.env, default) or dev
 *           (.env.dev). --db or BENCH_DATABASE_URL override it.
 */
import { readFileSync } from "node:fs";
import { SQL } from "bun";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const ENV_FILES: Record<string, string> = {
  prod: `${ROOT}/infra/private/worker.env`,
  dev: `${ROOT}/.env.dev`,
};

/** Provision phases in the order the worker runs them; ready_gate.* overlap ready_gate. */
const PROVISION_PHASES = [
  "queued",
  "prepare",
  "launch",
  "boot",
  "container_ssh",
  "dns_publish",
  "ready_gate",
  "ready_gate.ssh",
  "ready_gate.dns",
  "finalize",
] as const;

const SHORT: Record<string, string> = {
  queued: "queue",
  prepare: "prep",
  launch: "launch",
  boot: "boot",
  container_ssh: "ssh-setup",
  dns_publish: "dns",
  ready_gate: "gate",
  "ready_gate.ssh": "gate:ssh",
  "ready_gate.dns": "gate:dns",
  finalize: "final",
};

interface JobTimings {
  attempt: number;
  queued_ms: number;
  total_ms: number;
  phases: { name: string; ms: number }[];
}

interface BuildRow {
  name: string;
  plan_id: string;
  recipe_id: string | null;
  build_ms: number;
  started_at: Date;
  attempts: number;
  provision_timings: JobTimings | null;
  setup_timings: JobTimings | null;
}

interface FailureRow {
  plan_id: string;
  total: number;
  failed: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

function envFileValue(path: string, key: string): string {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] === key) return match[2]?.trim() ?? "";
  }
  return "";
}

function databaseUrl(): string {
  const explicit = arg("db") ?? process.env.BENCH_DATABASE_URL;
  if (explicit) return explicit;
  const env = arg("env") ?? "prod";
  const file = ENV_FILES[env];
  if (!file) throw new Error(`--env must be prod or dev, got ${env}`);
  const url = envFileValue(file, "DATABASE_URL");
  if (!url) throw new Error(`DATABASE_URL missing in ${file}`);
  return url;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

function secs(ms: number): string {
  return Number.isNaN(ms) ? "-" : (ms / 1000).toFixed(1);
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const numeric = headers.map((_, i) =>
    rows.every((r) => /^-?[\d.]+$|^-$/.test(r[i] ?? "")),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) =>
        numeric[i] ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

function phaseMs(t: JobTimings, phase: string): number | undefined {
  if (phase === "queued") return t.queued_ms;
  return t.phases.find((p) => p.name === phase)?.ms;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

function planLabel(b: BuildRow): string {
  return b.recipe_id ? `${b.plan_id} + ${b.recipe_id}` : b.plan_id;
}

function buildTimeSection(builds: BuildRow[]): string {
  const rows = [...groupBy(builds, planLabel)].map(([label, group]) => {
    const s = stats(group.map((b) => b.build_ms));
    return [
      label,
      String(s.n),
      secs(s.p50),
      secs(s.p90),
      secs(s.min),
      secs(s.max),
    ];
  });
  return table(["plan", "n", "p50 s", "p90 s", "min s", "max s"], rows);
}

function phaseSection(builds: BuildRow[]): string {
  const timed = builds.filter((b) => b.provision_timings !== null);
  if (timed.length === 0)
    return "(no phase data yet: builds after the 0018 deploy record it)";
  const blocks: string[] = [];
  for (const [plan, group] of groupBy(timed, (b) => b.plan_id)) {
    const rows: string[][] = [];
    for (const phase of PROVISION_PHASES) {
      const values = group
        .map((b) =>
          b.provision_timings ? phaseMs(b.provision_timings, phase) : undefined,
        )
        .filter((v): v is number => v !== undefined);
      if (values.length === 0) continue;
      const s = stats(values);
      rows.push([phase, String(s.n), secs(s.p50), secs(s.p90), secs(s.max)]);
    }
    blocks.push(
      `${plan}\n${table(["phase", "n", "p50 s", "p90 s", "max s"], rows)}`,
    );
  }
  return blocks.join("\n\n");
}

function setupSection(builds: BuildRow[]): string {
  const timed = builds.filter((b) => b.recipe_id && b.setup_timings);
  if (timed.length === 0) return "(no setup phase data yet)";
  const blocks: string[] = [];
  for (const [recipe, group] of groupBy(timed, (b) => b.recipe_id ?? "")) {
    const names = [
      ...new Set(
        group.flatMap((b) => b.setup_timings?.phases.map((p) => p.name) ?? []),
      ),
    ];
    const rows = ["queued", ...names].map((phase) => {
      const values = group
        .map((b) =>
          b.setup_timings ? phaseMs(b.setup_timings, phase) : undefined,
        )
        .filter((v): v is number => v !== undefined);
      const s = stats(values);
      return [phase, String(s.n), secs(s.p50), secs(s.p90), secs(s.max)];
    });
    blocks.push(
      `${recipe}\n${table(["step", "n", "p50 s", "p90 s", "max s"], rows)}`,
    );
  }
  return blocks.join("\n\n");
}

function phaseLine(t: JobTimings): string {
  return PROVISION_PHASES.map((phase) => {
    const ms = phaseMs(t, phase);
    return ms === undefined ? null : `${SHORT[phase]} ${secs(ms)}`;
  })
    .filter((part) => part !== null)
    .join(" · ");
}

function recentSection(builds: BuildRow[], limit: number): string {
  const rows = builds.slice(0, limit).map((b) => {
    const setup = b.setup_timings
      ? ` | setup ${secs(b.setup_timings.total_ms + b.setup_timings.queued_ms)}`
      : "";
    return [
      b.started_at.toISOString().slice(5, 16).replace("T", " "),
      planLabel(b),
      secs(b.build_ms),
      String(b.attempts),
      b.provision_timings
        ? phaseLine(b.provision_timings) + setup
        : "(built before phase timings)",
    ];
  });
  return table(
    ["started (UTC)", "plan", "built s", "tries", "phases (s)"],
    rows,
  );
}

function failureSection(failures: FailureRow[]): string {
  if (failures.length === 0) return "(no provision jobs in the window)";
  return table(
    ["plan", "jobs", "failed", "fail %"],
    failures.map((f) => [
      f.plan_id,
      String(f.total),
      String(f.failed),
      ((100 * f.failed) / f.total).toFixed(0),
    ]),
  );
}

async function main() {
  const days = intArg("days", 30);
  const recent = intArg("recent", 15);
  const db = new SQL({ url: databaseUrl(), max: 1 });
  try {
    await db`SET default_transaction_read_only = on`;
    const builds: BuildRow[] = await db`
      SELECT r.name, r.plan_id, r.recipe_id, r.build_ms,
        p.created_at AS started_at, p.attempts, p.timings AS provision_timings,
        s.timings AS setup_timings
      FROM server_requests r
      JOIN LATERAL (
        SELECT created_at, attempts, timings FROM provision_jobs
        WHERE request_id = r.id AND action = 'provision'
        ORDER BY created_at DESC LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT timings FROM provision_jobs
        WHERE request_id = r.id AND action = 'setup' AND status = 'done'
        ORDER BY updated_at DESC LIMIT 1
      ) s ON true
      WHERE r.build_ms IS NOT NULL
        AND p.created_at > now() - make_interval(days => ${days})
      ORDER BY p.created_at DESC`;
    const failures: FailureRow[] = await db`
      SELECT r.plan_id, count(*)::int AS total,
        (count(*) FILTER (WHERE j.status = 'failed'))::int AS failed
      FROM provision_jobs j JOIN server_requests r ON r.id = j.request_id
      WHERE j.action = 'provision' AND j.created_at > now() - make_interval(days => ${days})
      GROUP BY r.plan_id ORDER BY r.plan_id`;

    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ days, builds, failures }, null, 2));
      return;
    }
    console.log(
      `Provisioning benchmark: ${builds.length} build(s) in the last ${days} day(s)\n`,
    );
    console.log(
      `== Build time (request -> usable) ==\n${buildTimeSection(builds)}\n`,
    );
    console.log(`== Provision phases ==\n${phaseSection(builds)}\n`);
    console.log(`== Recipe setup steps ==\n${setupSection(builds)}\n`);
    console.log(`== Recent builds ==\n${recentSection(builds, recent)}\n`);
    console.log(`== Provision job failures ==\n${failureSection(failures)}`);
  } finally {
    await db.close();
  }
}

await main();
