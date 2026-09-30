import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateSite } from "./generate";
import { createOpenRouterClient } from "./openrouter";
import { PROMPT_VERSION } from "./prompts";
import { SiteBrief, type LlmCallRecord } from "./types";
import { renderSite } from "../render";

export function formatMicroUsd(amount: bigint): string {
  return `$${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}
export function costSummary(
  calls: readonly LlmCallRecord[],
  httpAttempts: number,
): string {
  const total = calls.reduce(
    (sum, call) => ({
      input: sum.input + call.inputTokens,
      output: sum.output + call.outputTokens,
      cached: sum.cached + call.cachedInputTokens,
      written: sum.written + call.cacheWriteTokens,
      cost: sum.cost + call.costMicroUsd,
    }),
    { input: 0, output: 0, cached: 0, written: 0, cost: 0n },
  );
  return `Calls: ${calls.length} (${httpAttempts} HTTP attempts)\nTokens: ${total.input} input, ${total.output} output, ${total.cached} cached, ${total.written} cache writes\nTotal cost: ${formatMicroUsd(total.cost)} USD`;
}

export async function runSmoke(args: string[]): Promise<number> {
  if (args.length !== 2) {
    console.error(
      "Usage: bun packages/sites/src/generate/smoke.ts <brief.json> <outDir>",
    );
    return 1;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required");
    return 1;
  }
  const calls: LlmCallRecord[] = [];
  let attempts = 0;
  try {
    const validation = SiteBrief.safeParse(
      await Bun.file(resolve(args[0]!)).json(),
    );
    if (!validation.success) {
      console.error(
        validation.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n"),
      );
      return 1;
    }
    // A real transport cap includes retries and is independent of model output.
    // Disable retries here so the five-attempt smoke allowance favours generation.
    const budgetedFetch = ((...params: Parameters<typeof globalThis.fetch>) => {
      if (attempts >= 5)
        throw new Error("Smoke HTTP attempt budget exhausted (maximum 5)");
      attempts++;
      return globalThis.fetch(...params);
    }) as typeof globalThis.fetch;
    console.log(`Prompt version: ${PROMPT_VERSION}`);
    const result = await generateSite(validation.data, {
      llm: createOpenRouterClient({
        apiKey,
        maxRetries: 0,
        fetch: budgetedFetch,
      }),
      models: {
        plan: process.env.SITES_MODEL_PLAN ?? "openai/gpt-oss-120b",
        fill: process.env.SITES_MODEL_FILL ?? "google/gemini-2.5-flash-lite",
        escalate: process.env.SITES_MODEL_ESCALATE ?? "openai/gpt-oss-120b",
      },
      concurrency: 2,
      onCall(call) {
        calls.push(call);
        console.log(
          `${call.stage}: ${call.model} via ${call.provider}; ${call.status}${call.errorCode ? ` (${call.errorCode})` : ""}; ${call.inputTokens}/${call.outputTokens} tokens; ${formatMicroUsd(call.costMicroUsd)} USD`,
        );
      },
    });
    if (!result.ok) {
      console.error(`Generation failed: ${result.error}`);
      return 1;
    }
    const rendered = renderSite(result.spec, {
      baseUrl: process.env.SITES_BASE_URL ?? "https://localhost",
    });
    const outDir = resolve(args[1]!);
    for (const [path, content] of rendered.files) {
      const target = resolve(outDir, path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }
    await Bun.write(
      resolve(outDir, "spec.json"),
      `${JSON.stringify(result.spec, null, 2)}\n`,
    );
    for (const warning of rendered.warnings)
      console.warn(`Warning: ${warning}`);
    console.log(
      `Rendered ${result.spec.pages.length} pages to ${outDir}; escalated: ${result.escalated}`,
    );
    return 0;
  } catch (error) {
    // Never emit a secret even if an unexpected filesystem/transport error echoes it.
    console.error(
      (error instanceof Error ? error.message : String(error))
        .split(apiKey)
        .join("[redacted]"),
    );
    return 1;
  } finally {
    console.log(costSummary(calls, attempts));
  }
}

if (import.meta.main) process.exitCode = await runSmoke(Bun.argv.slice(2));
