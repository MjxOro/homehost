import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  GenerateOptions,
  GenerateResult,
  SiteBrief,
  LlmCallRecord,
  LlmRequest,
} from "@homehost/sites";
import { hashLlmRequest, PROMPT_VERSION } from "./pipeline";
import { runBench } from "./run";
import { compareRuns, readRun } from "./report";
import {
  candidate,
  task,
  example,
  request,
  response,
  temporary,
} from "./fixtures.test-helper";

async function scripted(
  brief: SiteBrief,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const req: LlmRequest = {
    ...request,
    model: opts.models.plan,
    messages: [{ role: "user", content: brief.description }],
  };
  const r = await opts.llm.complete(req);
  const call: LlmCallRecord = {
    stage: "plan",
    provider: r.provider,
    model: r.model,
    providerRequestId: r.providerRequestId,
    promptHash: hashLlmRequest(req),
    ...r.usage,
    latencyMs: r.latencyMs,
    status: "ok",
    errorCode: null,
  };
  opts.onCall?.(call);
  if (brief.description.includes("fail"))
    return {
      ok: false,
      error: "scripted failure",
      calls: [call],
      escalated: true,
    };
  const spec = structuredClone(example);
  if (brief.description.includes("grade-bad"))
    spec.pages[0]!.sections.push({
      type: "about.text",
      heading: "TODO",
      text: "Unfinished copy",
    });
  return { ok: true, spec, calls: [call], escalated: false, warnings: [] };
}
const git = async () => ({ sha: "pinned-test-sha", dirty: true });

test("record cache hits run at zero cap and billed answers count even when cache storage fails", async () => {
  const temp = await temporary();
  try {
    const options = {
      candidate,
      tasks: [task],
      repeats: 1,
      concurrency: 1,
      cache: "record" as const,
      outputRoot: temp.dir,
      cacheDir: join(temp.dir, "cache"),
    };
    await runBench(options, {
      git,
      generate: scripted,
      llm: { complete: async () => response() },
    });
    const cached = await runBench(
      { ...options, maxUsd: 0 },
      {
        git,
        generate: scripted,
        llm: {
          complete: async () => {
            throw new Error("No live calls");
          },
        },
      },
    );
    expect(cached.manifest.stopped).toBeNull();
    expect(cached.results[0]?.spentMicroUsd).toBe("0");
    expect(cached.results[0]?.ok).toBe(true);
    const blockedDir = join(temp.dir, "not-a-directory");
    await Bun.write(blockedDir, "block cache mkdir");
    const failed = await runBench(
      { ...options, cacheDir: blockedDir },
      { git, generate: scripted, llm: { complete: async () => response() } },
    );
    expect(failed.results[0]?.ok).toBe(false);
    expect(failed.results[0]?.spentMicroUsd).toBe("1000");
    expect(failed.manifest.spentMicroUsd).toBe("1000");
  } finally {
    await temp.cleanup();
  }
});

test("injected runner records and replays independent repeats for zero spend, in deterministic order", async () => {
  const temp = await temporary();
  try {
    let calls = 0,
      active = 0,
      maxActive = 0;
    const tasks = ["slow", "fast", "middle"].map((id) => ({
      ...task,
      id,
      brief: { ...task.brief, description: id },
    }));
    const options = {
      candidate,
      tasks,
      repeats: 2,
      concurrency: 2,
      cache: "record" as const,
      maxUsd: 0.1,
      outputRoot: temp.dir,
      cacheDir: join(temp.dir, "cache"),
    };
    const live = await runBench(options, {
      git,
      generate: scripted,
      llm: {
        complete: async (req) => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) =>
            setTimeout(resolve, req.messages[0]?.content === "slow" ? 20 : 1),
          );
          active--;
          return response();
        },
      },
    });
    expect(calls).toBe(6);
    expect(maxActive).toBe(2);
    expect(live.results.map((r) => `${r.taskId}:${r.repeat}`)).toEqual([
      "slow:1",
      "slow:2",
      "fast:1",
      "fast:2",
      "middle:1",
      "middle:2",
    ]);
    expect(live.results.every((r) => r.ok)).toBe(true);
    expect(live.manifest.spentMicroUsd).toBe("6000");
    expect(live.manifest.gitSha).toBe("pinned-test-sha");
    expect(live.manifest.promptVersion).toBe(PROMPT_VERSION);
    expect(Object.values(live.manifest.requestParams)[0]?.temperature).toBe(
      0.2,
    );
    expect(await readdir(live.dir)).not.toContain("failed");
    const replay = await runBench(
      { ...options, cache: "replay", maxUsd: 0 },
      {
        git,
        generate: scripted,
        llm: {
          complete: async () => {
            throw new Error("No network");
          },
        },
      },
    );
    expect(replay.manifest.spentMicroUsd).toBe("0");
    expect(
      replay.results.map(({ latencyMs, spentMicroUsd, calls, ...r }) => ({
        ...r,
        calls: calls.map(({ cacheStatus, ...c }) => c),
      })),
    ).toEqual(
      live.results.map(({ latencyMs, spentMicroUsd, calls, ...r }) => ({
        ...r,
        calls: calls.map(({ cacheStatus, ...c }) => c),
      })),
    );
    expect(
      replay.results.every((r) =>
        r.calls.every((c) => c.cacheStatus === "hit"),
      ),
    ).toBe(true);
    expect((await readRun(replay.dir)).rows).toEqual(replay.results);
    expect(await compareRuns(live.dir, replay.dir)).toContain("delta 0.0%");
  } finally {
    await temp.cleanup();
  }
});

test("spend cap stops with partial results saved, without starting the next task", async () => {
  const temp = await temporary();
  try {
    let calls = 0;
    const run = await runBench(
      {
        candidate,
        tasks: [
          { ...task, id: "first" },
          { ...task, id: "second" },
        ],
        repeats: 1,
        concurrency: 1,
        cache: "live",
        maxUsd: 0.001,
        outputRoot: temp.dir,
      },
      {
        git,
        generate: scripted,
        llm: {
          complete: async () => {
            calls++;
            return response();
          },
        },
      },
    );
    expect(calls).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.manifest.stopped).toContain("cap reached");
    expect((await readRun(run.dir)).rows).toHaveLength(1);
  } finally {
    await temp.cleanup();
  }
});

test("cache miss stops cleanly without network, with failed-attempt metadata", async () => {
  const temp = await temporary();
  try {
    const run = await runBench(
      {
        candidate,
        tasks: [task],
        repeats: 1,
        cache: "replay",
        outputRoot: temp.dir,
        cacheDir: join(temp.dir, "empty-cache"),
      },
      {
        git,
        generate: scripted,
        llm: {
          complete: async () => {
            throw new Error("No network");
          },
        },
      },
    );
    expect(run.manifest.stopped).toContain("cache miss");
    expect(run.results[0]?.ok).toBe(false);
    expect(
      await Bun.file(
        join(run.dir, "failed", task.id, "repeat-1", "attempt.json"),
      ).exists(),
    ).toBe(true);
  } finally {
    await temp.cleanup();
  }
});

test("grader failures save rendered files while generation failures save metadata only", async () => {
  const temp = await temporary();
  try {
    const tasks = ["grade-bad", "fail"].map((id) => ({
      ...task,
      id,
      brief: { ...task.brief, description: id },
    }));
    const run = await runBench(
      { candidate, tasks, repeats: 1, cache: "live", outputRoot: temp.dir },
      { git, generate: scripted, llm: { complete: async () => response() } },
    );
    expect(run.results.every((r) => !r.ok)).toBe(true);
    expect(
      await Bun.file(
        join(run.dir, "failed", "grade-bad", "repeat-1", "index.html"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        join(run.dir, "failed", "grade-bad", "repeat-1", "styles.css"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        join(run.dir, "failed", "fail", "repeat-1", "index.html"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(run.dir, "failed", "fail", "repeat-1", "attempt.json"),
      ).exists(),
    ).toBe(true);
  } finally {
    await temp.cleanup();
  }
});
