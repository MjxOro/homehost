import { join } from "node:path";
import { mean, percentile, wilson, disjoint } from "./stats";
import type { ResultRow, RunManifest } from "./run";

export function aggregate(rows: ResultRow[]) {
  const costs = rows.map((r) => Number(BigInt(r.costMicroUsd)) / 1e6);
  const spentMicroUsd = rows.reduce((n, r) => n + BigInt(r.spentMicroUsd), 0n);
  const costMicroUsd = rows.reduce((n, r) => n + BigInt(r.costMicroUsd), 0n);
  const graderIds = [
    ...new Set(rows.flatMap((r) => r.graders.map((g) => g.id))),
  ].sort();
  const graders = Object.fromEntries(
    graderIds.map((id) => [
      id,
      wilson(
        rows.filter((r) => r.graders.some((g) => g.id === id && g.pass)).length,
        rows.length,
      ),
    ]),
  );
  const tokens = rows.reduce(
    (n, r) => ({
      input: n.input + r.tokens.input,
      output: n.output + r.tokens.output,
      cached: n.cached + r.tokens.cached,
      cacheWrite: n.cacheWrite + r.tokens.cacheWrite,
    }),
    { input: 0, output: 0, cached: 0, cacheWrite: 0 },
  );
  const perTask = [...new Set(rows.map((r) => r.taskId))].map((id) => {
    const trials = rows.filter((r) => r.taskId === id);
    const values = trials.map((r) => (r.ok ? 1 : 0));
    return {
      id,
      repeats: trials.length,
      ...wilson(
        values.reduce<number>((a, b) => a + b, 0),
        values.length,
      ),
      sd: Math.sqrt(mean(values.map((v) => (v - mean(values)) ** 2))),
    };
  });
  return {
    n: rows.length,
    passed: rows.filter((r) => r.ok).length,
    passRate: wilson(rows.filter((r) => r.ok).length, rows.length),
    graders,
    perTask,
    cost: {
      mean: mean(costs),
      p50: percentile(costs, 0.5),
      p95: percentile(costs, 0.95),
      total: Number(costMicroUsd) / 1e6,
      spent: Number(spentMicroUsd) / 1e6,
    },
    tokens,
    cachedTokenRatio: tokens.input ? tokens.cached / tokens.input : 0,
    latency: {
      p50: percentile(
        rows.map((r) => r.latencyMs),
        0.5,
      ),
      p95: percentile(
        rows.map((r) => r.latencyMs),
        0.95,
      ),
    },
    modelLatency: {
      p50: percentile(
        rows.map((r) => r.modelLatencyMs),
        0.5,
      ),
      p95: percentile(
        rows.map((r) => r.modelLatencyMs),
        0.95,
      ),
    },
    escalationRate: mean(rows.map((r) => (r.escalated ? 1 : 0))),
    callsPerTask: mean(rows.map((r) => r.calls.length)),
    cacheHits: rows
      .flatMap((r) => r.calls)
      .filter((c) => c.cacheStatus === "hit").length,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const dollars = (n: number) => `$${n.toFixed(6)}`;
const interval = (n: ReturnType<typeof wilson>) =>
  `${pct(n.p)} (95% Wilson CI ${pct(n.low)}–${pct(n.high)})`;

export async function readRun(
  dir: string,
): Promise<{ manifest: RunManifest; rows: ResultRow[] }> {
  const manifest = (await Bun.file(
    join(dir, "run.json"),
  ).json()) as RunManifest;
  const content = await Bun.file(join(dir, "results.jsonl")).text();
  const rows = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as ResultRow;
      } catch {
        throw new Error(`Invalid results.jsonl line ${index + 1}`);
      }
    });
  return { manifest, rows };
}

export async function reportRun(dir: string): Promise<string> {
  const { manifest, rows } = await readRun(dir),
    report = aggregate(rows);
  const markdown = [
    `# Benchmark: ${manifest.candidate.id}`,
    "",
    `Revision: \`${manifest.gitSha}\`${manifest.dirty ? " (dirty)" : ""}; prompt: \`${manifest.promptVersion}\`; cache: ${manifest.args.cache}.`,
    `Models: plan \`${manifest.candidate.models.plan}\`, fill \`${manifest.candidate.models.fill}\`, escalate \`${manifest.candidate.models.escalate}\`.`,
    "",
    `Pass: **${report.passed}/${report.n} — ${interval(report.passRate)}**.`,
    `Recorded cost: **${dollars(report.cost.total)}**; spent this run: **${dollars(report.cost.spent)}**.`,
    `Cost per task×repeat: mean ${dollars(report.cost.mean)}, p50 ${dollars(report.cost.p50)}, p95 ${dollars(report.cost.p95)}.`,
    `Tokens: ${report.tokens.input} in / ${report.tokens.output} out / ${report.tokens.cached} cached / ${report.tokens.cacheWrite} cache-write; cached-input ratio ${pct(report.cachedTokenRatio)}.`,
    `Wall latency: p50 ${report.latency.p50.toFixed(0)} ms, p95 ${report.latency.p95.toFixed(0)} ms.`,
    `Sum of original model-call latency: p50 ${report.modelLatency.p50.toFixed(0)} ms, p95 ${report.modelLatency.p95.toFixed(0)} ms (parallel calls overlap).`,
    `Escalation: ${pct(report.escalationRate)}; calls per task×repeat: ${report.callsPerTask.toFixed(2)}; replay-cache hits: ${report.cacheHits}.`,
    ...(manifest.stopped ? [`Partial run: ${manifest.stopped}.`] : []),
    "",
    "## Graders",
    "",
    "| Grader | Pass rate and 95% CI |",
    "|---|---|",
    ...Object.entries(report.graders).map(
      ([id, rate]) => `| ${id} | ${interval(rate)} |`,
    ),
    "",
    "## Repeat spread",
    "",
    "| Task | N | Mean pass rate and 95% CI | Pass SD |",
    "|---|---:|---|---:|",
    ...report.perTask.map(
      (t) => `| ${t.id} | ${t.repeats} | ${interval(t)} | ${t.sd.toFixed(3)} |`,
    ),
    "",
    "Trials are task×repeat, not unique businesses. Wilson intervals are descriptive: repeats of a task are correlated; use task-level comparisons before drawing conclusions.",
    "",
  ].join("\n");
  await Bun.write(join(dir, "report.md"), markdown);
  return markdown;
}

export async function compareRuns(aDir: string, bDir: string): Promise<string> {
  const [a, b] = await Promise.all([readRun(aDir), readRun(bDir)]);
  const x = aggregate(a.rows),
    y = aggregate(b.rows);
  const compatible =
    JSON.stringify(a.manifest.taskSnapshots) ===
      JSON.stringify(b.manifest.taskSnapshots) &&
    a.manifest.args.repeats === b.manifest.args.repeats;
  return [
    "# Benchmark comparison",
    "",
    `${a.manifest.candidate.id} → ${b.manifest.candidate.id}`,
    "",
    ...(compatible
      ? []
      : [
          "WARNING: task snapshots/repeat counts differ; this is not a controlled comparison.",
          "",
        ]),
    `Pass: ${interval(x.passRate)} → ${interval(y.passRate)}; delta ${pct(y.passRate.p - x.passRate.p)}.`,
    `Non-overlapping pass CIs: **${disjoint(x.passRate, y.passRate) ? "YES — flagged" : "no"}** (not a paired significance test).`,
    `Recorded cost/task delta: ${dollars(y.cost.mean - x.cost.mean)}; spent total delta: ${dollars(y.cost.spent - x.cost.spent)}.`,
    `Latency p50/p95 delta: ${(y.latency.p50 - x.latency.p50).toFixed(0)} / ${(y.latency.p95 - x.latency.p95).toFixed(0)} ms.`,
    `Escalation delta: ${pct(y.escalationRate - x.escalationRate)}; calls/task delta: ${(y.callsPerTask - x.callsPerTask).toFixed(2)}.`,
    "",
    "| Grader | Pass-rate delta |",
    "|---|---:|",
    ...[...new Set([...Object.keys(x.graders), ...Object.keys(y.graders)])]
      .sort()
      .map(
        (id) =>
          `| ${id} | ${pct((y.graders[id]?.p ?? 0) - (x.graders[id]?.p ?? 0))} |`,
      ),
    "",
  ].join("\n");
}
