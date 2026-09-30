import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createOpenRouterClient } from "./pipeline";
import { loadCandidate, selectTasks } from "./tasks";
import { runBench } from "./run";
import { reportRun, compareRuns } from "./report";
import type { CacheMode } from "./cache";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "report" && argv.length === 2) {
    console.log(await reportRun(resolve(argv[1]!)));
    return;
  }
  if (command === "compare" && argv.length === 3) {
    console.log(await compareRuns(resolve(argv[1]!), resolve(argv[2]!)));
    return;
  }
  if (command !== "run")
    throw new Error(
      "Usage: bench run --candidate <id> [options] | report <runDir> | compare <runDirA> <runDirB>",
    );
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    options: Object.fromEntries(
      [
        "candidate",
        "suite",
        "tasks",
        "limit",
        "repeats",
        "cache",
        "max-usd",
        "concurrency",
        "cache-dir",
      ].map((name) => [name, { type: "string" as const }]),
    ),
  });
  const value = (key: string) => values[key] as string | undefined;
  const positive = (key: string, fallback?: number) => {
    const text = value(key),
      n = text === undefined ? fallback : Number(text);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 1000))
      throw new Error(`--${key} must be an integer from 1 to 1000`);
    return n;
  };
  if (!value("candidate")) throw new Error("--candidate is required");
  const cache = value("cache") ?? "record";
  if (!["live", "record", "replay"].includes(cache))
    throw new Error("--cache must be live, record or replay");
  const maxUsd = Number(value("max-usd") ?? 1);
  if (!Number.isFinite(maxUsd) || maxUsd < 0)
    throw new Error("--max-usd must be a finite nonnegative number");
  const repeats = positive("repeats", 3),
    concurrency = positive("concurrency", 3),
    limit = positive("limit");
  const candidate = await loadCandidate(value("candidate")!);
  const tasks = await selectTasks({
    suite: value("suite"),
    ids: value("tasks")?.split(","),
    limit,
  });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (cache !== "replay" && !apiKey)
    throw new Error("OPENROUTER_API_KEY is required for live/record runs");
  const llm =
    cache === "replay"
      ? {
          complete: async () => {
            throw new Error("Replay must never call a live model");
          },
        }
      : createOpenRouterClient({ apiKey: apiKey! });
  const run = await runBench(
    {
      candidate,
      tasks,
      repeats,
      concurrency,
      cache: cache as CacheMode,
      maxUsd,
      cacheDir: value("cache-dir"),
    },
    { llm },
  );
  console.log(run.dir);
  if (run.manifest.stopped) {
    console.error(
      `Stopped cleanly with ${run.results.length} saved results: ${run.manifest.stopped}`,
    );
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
