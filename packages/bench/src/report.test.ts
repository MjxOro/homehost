import { expect, test } from "bun:test";
import { join } from "node:path";
import { aggregate, compareRuns, reportRun, readRun } from "./report";
import { candidate, task, temporary } from "./fixtures.test-helper";
import type { ResultRow } from "./run";

async function writeFixture(dir: string, rows?: ResultRow[]) {
  await Bun.write(
    join(dir, "run.json"),
    JSON.stringify({
      version: 1,
      gitSha: "test-sha",
      dirty: false,
      promptVersion: "fixture-v1",
      candidate,
      args: { cache: "record", repeats: 2 },
      taskSnapshots: [task],
      stopped: null,
    }),
  );
  await Bun.write(
    join(dir, "results.jsonl"),
    rows
      ? rows.map((r) => JSON.stringify(r)).join("\n")
      : await Bun.file(
          new URL("./fixtures/results.jsonl", import.meta.url),
        ).text(),
  );
}
test("fixture JSONL aggregation reports costs, tokens, quantiles, rates and repeat spread", async () => {
  const temp = await temporary();
  try {
    await writeFixture(temp.dir);
    const { rows } = await readRun(temp.dir),
      result = aggregate(rows);
    expect(result.n).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.passRate.p).toBeCloseTo(2 / 3);
    expect(result.cost.total).toBeCloseTo(0.006);
    expect(result.cost.spent).toBeCloseTo(0.003);
    expect(result.cost.mean).toBeCloseTo(0.002);
    expect(result.cost.p50).toBeCloseTo(0.002);
    expect(result.cost.p95).toBeCloseTo(0.0029);
    expect(result.tokens).toEqual({
      input: 300,
      output: 90,
      cached: 180,
      cacheWrite: 30,
    });
    expect(result.cachedTokenRatio).toBe(0.6);
    expect(result.latency.p95).toBe(290);
    expect(result.escalationRate).toBeCloseTo(1 / 3);
    expect(result.graders.schemaValid?.p).toBeCloseTo(2 / 3);
    expect(result.perTask.find((t) => t.id === "first")?.repeats).toBe(2);
    const markdown = await reportRun(temp.dir);
    expect(markdown).toContain("$0.006000");
    expect(markdown).toContain("$0.003000");
    expect(markdown).toContain("Wilson");
    expect(await Bun.file(join(temp.dir, "report.md")).text()).toBe(markdown);
  } finally {
    await temp.cleanup();
  }
});
test("compare flags non-overlapping intervals and mismatched trials; empty report is defined", async () => {
  const a = await temporary(),
    b = await temporary();
  try {
    await writeFixture(a.dir);
    const fixture = (await readRun(a.dir)).rows[0]!;
    await writeFixture(
      a.dir,
      Array.from({ length: 100 }, () => ({ ...fixture, ok: true })),
    );
    await writeFixture(
      b.dir,
      Array.from({ length: 100 }, () => ({ ...fixture, ok: false })),
    );
    expect(await compareRuns(a.dir, b.dir)).toContain("YES — flagged");
    const manifest = (await readRun(b.dir)).manifest;
    manifest.args.repeats = 3;
    await Bun.write(join(b.dir, "run.json"), JSON.stringify(manifest));
    expect(await compareRuns(a.dir, b.dir)).toContain(
      "not a controlled comparison",
    );
    await writeFixture(a.dir, []);
    expect(await reportRun(a.dir)).toContain("0/0");
    expect(aggregate([]).cost.total).toBe(0);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});
