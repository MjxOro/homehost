import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { LlmClient, LlmRequest, LlmResponse } from "@homehost/sites";
import { hashLlmRequest, LlmClientError } from "./pipeline";

export type CacheMode = "live" | "record" | "replay";

/** Response as returned by the cache layer: says where it came from. */
export type CachedResponse = LlmResponse & { cacheStatus: "hit" | "live" };

export class CacheMiss extends Error {
  constructor(readonly key: string) {
    super(
      `replay cache miss for request ${key}: record it first with --cache record`,
    );
    this.name = "CacheMiss";
  }
}

// bigint is not JSON: costMicroUsd is stored as a decimal string.
const StoredResponse = z.strictObject({
  version: z.literal(1),
  key: z.string(),
  error: z.strictObject({ message: z.string(), code: z.string() }).optional(),
  response: z.strictObject({
    content: z.string(),
    provider: z.string(),
    model: z.string(),
    providerRequestId: z.string().nullable(),
    usage: z.strictObject({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cachedInputTokens: z.number(),
      cacheWriteTokens: z.number(),
      costMicroUsd: z.string().regex(/^\d+$/),
    }),
    latencyMs: z.number(),
  }),
});

function toStored(key: string, r: LlmResponse): z.infer<typeof StoredResponse> {
  return {
    version: 1,
    key,
    response: {
      content: r.content,
      provider: r.provider,
      model: r.model,
      providerRequestId: r.providerRequestId,
      usage: { ...r.usage, costMicroUsd: r.usage.costMicroUsd.toString() },
      latencyMs: r.latencyMs,
    },
  };
}

function fromStored(stored: z.infer<typeof StoredResponse>): LlmResponse {
  const { usage, ...rest } = stored.response;
  return {
    ...rest,
    usage: { ...usage, costMicroUsd: BigInt(usage.costMicroUsd) },
  };
}

/**
 * Record/replay cache keyed by `hashLlmRequest`.
 * - live: pass through, touch nothing.
 * - record: serve from disk when present, otherwise call through and store.
 * - replay: serve from disk; a miss throws `CacheMiss` (no live call, ever).
 * A hit keeps the original call's latency and cost so reports can show
 * "recorded" versus "spent this run".
 */
export function withCache(
  inner: LlmClient,
  opts: { dir: string; mode: CacheMode },
): LlmClient {
  const fileFor = (key: string) => join(opts.dir, `${key}.json`);
  async function store(key: string, value: z.infer<typeof StoredResponse>) {
    await mkdir(opts.dir, { recursive: true });
    const tmp = `${fileFor(key)}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, JSON.stringify(value));
    await rename(tmp, fileFor(key));
  }
  return {
    async complete(request: LlmRequest): Promise<CachedResponse> {
      if (opts.mode === "live") {
        return { ...(await inner.complete(request)), cacheStatus: "live" };
      }
      const key = hashLlmRequest(request);
      const file = Bun.file(fileFor(key));
      if (await file.exists()) {
        const stored = StoredResponse.parse(await file.json());
        if (stored.key !== key)
          throw new Error(`cache key mismatch for ${key}`);
        if (stored.error)
          throw Object.assign(
            new LlmClientError(
              stored.error.message,
              stored.error.code,
              fromStored(stored),
            ),
            { cacheStatus: "hit" as const },
          );
        return { ...fromStored(stored), cacheStatus: "hit" };
      }
      if (opts.mode === "replay") throw new CacheMiss(key);
      let response: LlmResponse;
      const started = performance.now();
      try {
        response = await inner.complete(request);
      } catch (error) {
        // Failed provider calls affect escalation prompts too. Cache their
        // exact redacted message/code and usage, but NEVER budget/cache misses.
        if (!(error instanceof LlmClientError)) throw error;
        const telemetry = error.response ?? {
          content: "",
          provider: "unknown",
          model: request.model,
          providerRequestId: null,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            costMicroUsd: 0n,
          },
          latencyMs: Math.round(performance.now() - started),
        };
        await store(key, {
          ...toStored(key, telemetry),
          error: { message: error.message, code: error.code },
        });
        throw Object.assign(
          new LlmClientError(error.message, error.code, telemetry),
          { cacheStatus: "live" as const },
        );
      }
      await store(key, toStored(key, response));
      return { ...response, cacheStatus: "live" };
    },
  };
}
