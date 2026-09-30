import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  renderSite,
  type GenerateOptions,
  type GenerateResult,
  type LlmCallRecord,
  type LlmClient,
  type LlmRequest,
} from "@homehost/sites";
import { PROMPT_VERSION, generateSite, hashLlmRequest } from "./pipeline";
import {
  withCache,
  CacheMiss,
  type CachedResponse,
  type CacheMode,
} from "./cache";
import {
  SpendGuard,
  SpendCapExceeded,
  usdToMicro,
  withSpendGuard,
} from "./spend";
import { gradeSite, type Grade } from "./graders";
import type { Candidate, Task } from "./tasks";

export type BenchCall = Omit<LlmCallRecord, "costMicroUsd"> & {
  costMicroUsd: string;
  cacheStatus: "hit" | "live" | "error";
};
export type ResultRow = {
  taskId: string;
  repeat: number;
  ok: boolean;
  generated: boolean;
  error: string | null;
  graders: Grade[];
  calls: BenchCall[];
  costMicroUsd: string;
  spentMicroUsd: string;
  tokens: { input: number; output: number; cached: number; cacheWrite: number };
  latencyMs: number;
  modelLatencyMs: number;
  escalated: boolean;
};
export type RunOptions = {
  candidate: Candidate;
  tasks: Task[];
  repeats?: number;
  concurrency?: number;
  cache?: CacheMode;
  cacheDir?: string;
  maxUsd?: number;
  outputRoot?: string;
};
export type RunManifest = {
  version: 1;
  gitSha: string;
  dirty: boolean;
  promptVersion: string;
  candidate: Candidate;
  args: {
    tasks: string[];
    repeats: number;
    concurrency: number;
    cache: CacheMode;
    cacheDir: string;
    maxUsd: number;
  };
  taskSnapshots: Task[];
  requestParams: Record<
    string,
    Omit<LlmRequest, "messages" | "jsonSchema"> & { schemaName?: string }
  >;
  startedAt: string;
  finishedAt?: string;
  stopped: string | null;
  spentMicroUsd?: string;
};

export async function runBench(
  options: RunOptions,
  dependencies: {
    llm: LlmClient;
    generate?: (
      brief: Task["brief"],
      opts: GenerateOptions,
    ) => Promise<GenerateResult>;
    git?: () => Promise<{ sha: string; dirty: boolean }>;
  },
): Promise<{ dir: string; manifest: RunManifest; results: ResultRow[] }> {
  const repeats = options.repeats ?? 3,
    concurrency = options.concurrency ?? 3,
    cache = options.cache ?? "record",
    maxUsd = options.maxUsd ?? 1;
  if (
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isFinite(maxUsd) ||
    maxUsd < 0
  )
    throw new Error("Invalid repeats, concurrency or spend cap");
  if (
    !options.tasks.length ||
    new Set(options.tasks.map((t) => t.id)).size !== options.tasks.length
  )
    throw new Error("Tasks must be nonempty and unique");
  const startedAt = new Date().toISOString();
  const dir = resolve(
    options.outputRoot ?? "bench-runs",
    `${startedAt.replace(/[:.]/g, "-")}-${options.candidate.id}-${crypto.randomUUID().slice(0, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  const git = dependencies.git
    ? await dependencies.git()
    : await (async () => {
        const sha = Bun.spawn(["git", "rev-parse", "HEAD"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const status = Bun.spawn(["git", "status", "--porcelain"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [shaText, statusText] = await Promise.all([
          new Response(sha.stdout).text(),
          new Response(status.stdout).text(),
        ]);
        if ((await sha.exited) || (await status.exited))
          throw new Error("Cannot pin git revision");
        return { sha: shaText.trim(), dirty: !!statusText.trim() };
      })();
  const cacheDir = resolve(options.cacheDir ?? ".bench-cache");
  const manifest: RunManifest = {
    version: 1,
    gitSha: git.sha,
    dirty: git.dirty,
    promptVersion: PROMPT_VERSION,
    candidate: options.candidate,
    args: {
      tasks: options.tasks.map((t) => t.id),
      repeats,
      concurrency,
      cache,
      cacheDir,
      maxUsd,
    },
    taskSnapshots: options.tasks,
    requestParams: {},
    startedAt,
    stopped: null,
  };
  const manifestPath = join(dir, "run.json"),
    resultsPath = join(dir, "results.jsonl");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await Bun.write(resultsPath, "");
  const guard = new SpendGuard(usdToMicro(maxUsd));
  const live = withSpendGuard(dependencies.llm, guard);
  const jobs = options.tasks.flatMap((task) =>
    Array.from({ length: repeats }, (_, repeat) => ({
      task,
      repeat: repeat + 1,
    })),
  );
  const rows = new Map<number, ResultRow>();
  let cursor = 0,
    stopped: string | null = null;
  // Serialize checkpoint writes so overlapping completions cannot lose rows.
  let checkpoint = Promise.resolve();
  function save() {
    checkpoint = checkpoint.then(async () => {
      const ordered = [...rows].sort(([a], [b]) => a - b).map(([, row]) => row);
      await Bun.write(
        resultsPath,
        ordered.map((row) => JSON.stringify(row)).join("\n") +
          (ordered.length ? "\n" : ""),
      );
    });
    return checkpoint;
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (!stopped) {
        const index = cursor++;
        const job = jobs[index];
        if (!job) break;
        const started = performance.now(),
          observed: LlmCallRecord[] = [];
        const responses = new Map<string, ("hit" | "live" | "error")[]>();
        let spent = 0n;
        // Attribute spend below the cache: even a failed disk write after a
        // billed answer must count, while cached answers never add live spend.
        const cached = withCache(
          {
            async complete(request) {
              try {
                const response = await live.complete(request);
                spent += response.usage.costMicroUsd;
                return response;
              } catch (error) {
                const billed = (
                  error as { response?: { usage?: { costMicroUsd?: bigint } } }
                )?.response?.usage?.costMicroUsd;
                if (typeof billed === "bigint") spent += billed;
                throw error;
              }
            },
          },
          { dir: join(cacheDir, `repeat-${job.repeat}`), mode: cache },
        );
        const llm: LlmClient = {
          async complete(request) {
            const hash = hashLlmRequest(request);
            manifest.requestParams[hash] = {
              model: request.model,
              temperature: request.temperature,
              maxOutputTokens: request.maxOutputTokens,
              schemaName: request.jsonSchema?.name,
            };
            let status: "hit" | "live" | "error" = "error";
            try {
              const response = (await cached.complete(
                request,
              )) as CachedResponse;
              status = response.cacheStatus;
              return response;
            } catch (error) {
              const source = (error as { cacheStatus?: "hit" | "live" })
                ?.cacheStatus;
              if (source === "hit" || source === "live") status = source;
              if (
                error instanceof SpendCapExceeded ||
                error instanceof CacheMiss
              )
                stopped = error.message;
              throw error;
            } finally {
              const queue = responses.get(hash) ?? [];
              queue.push(status);
              responses.set(hash, queue);
            }
          },
        };
        let result: GenerateResult;
        try {
          result = await (dependencies.generate ?? generateSite)(
            job.task.brief,
            {
              llm,
              models: options.candidate.models,
              concurrency: options.candidate.concurrency,
              onCall: (call) => observed.push(call),
            },
          );
        } catch (error) {
          result = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            calls: observed,
            escalated: observed.some((c) => c.stage === "escalate"),
          };
        }
        let files: Map<string, string> | undefined;
        let renderError: string | null = null;
        if (result.ok) {
          try {
            files = renderSite(result.spec, {
              baseUrl: "https://bench.invalid",
            }).files;
          } catch (error) {
            renderError = String(error);
          }
        }
        const graders = gradeSite(
          job.task,
          result.ok ? result.spec : undefined,
          files,
        );
        const calls = result.calls
          .map((call) => ({
            ...call,
            costMicroUsd: call.costMicroUsd.toString(),
            cacheStatus: responses.get(call.promptHash)?.shift() ?? "error",
          }))
          .sort((a, b) => {
            const stage = { plan: 0, fill: 1, escalate: 2 };
            return (
              stage[a.stage] - stage[b.stage] ||
              a.promptHash.localeCompare(b.promptHash)
            );
          });
        const row: ResultRow = {
          taskId: job.task.id,
          repeat: job.repeat,
          ok: result.ok && graders.every((g) => g.pass),
          generated: result.ok,
          error: result.ok ? renderError : result.error,
          graders,
          calls,
          costMicroUsd: result.calls
            .reduce((sum, c) => sum + c.costMicroUsd, 0n)
            .toString(),
          spentMicroUsd: spent.toString(),
          tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
          latencyMs: performance.now() - started,
          modelLatencyMs: result.calls.reduce((sum, c) => sum + c.latencyMs, 0),
          escalated: result.escalated,
        };
        for (const c of result.calls) {
          row.tokens.input += c.inputTokens;
          row.tokens.output += c.outputTokens;
          row.tokens.cached += c.cachedInputTokens;
          row.tokens.cacheWrite += c.cacheWriteTokens;
        }
        if (!row.ok) {
          const failureDir = join(
            dir,
            "failed",
            job.task.id,
            `repeat-${job.repeat}`,
          );
          await mkdir(failureDir, { recursive: true });
          await Bun.write(
            join(failureDir, "attempt.json"),
            JSON.stringify(
              {
                task: job.task,
                spec: result.ok ? result.spec : null,
                error: row.error,
                graders,
              },
              null,
              2,
            ),
          );
          for (const [path, content] of files ?? []) {
            const target = join(failureDir, path);
            await mkdir(resolve(target, ".."), { recursive: true });
            await Bun.write(target, content);
          }
        }
        rows.set(index, row);
        if (
          guard.spentMicroUsd > 0n &&
          guard.spentMicroUsd >= guard.capMicroUsd &&
          cache !== "replay"
        )
          stopped ??= `bench spend cap reached (${guard.spentMicroUsd} micro-USD)`;
        await save();
      }
    }),
  );
  await checkpoint;
  manifest.finishedAt = new Date().toISOString();
  manifest.stopped = stopped;
  manifest.spentMicroUsd = guard.spentMicroUsd.toString();
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return {
    dir,
    manifest,
    results: [...rows].sort(([a], [b]) => a - b).map(([, row]) => row),
  };
}
