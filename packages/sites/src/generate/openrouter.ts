import { z } from "zod/v4";
import type { LlmClient, LlmRequest, LlmResponse } from "./types";

const count = z.number().int().nonnegative().optional();
const envelope = z.object({
  id: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: count,
      completion_tokens: count,
      cost: z.number().nonnegative().optional(),
      cache_write_tokens: count,
      prompt_tokens_details: z
        .object({ cached_tokens: count, cache_write_tokens: count })
        .optional(),
    })
    .optional(),
});

/** Carries known billed usage even if the provider returned no usable content. */
export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly response?: LlmResponse,
  ) {
    super(message);
    this.name = "LlmClientError";
  }
}

export type OpenRouterClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test transport or a caller's HTTP-attempt budget. */
  fetch?: typeof globalThis.fetch;
  /** The contract's complete(request) stays unchanged; bind cancellation here. */
  signal?: AbortSignal;
};

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createOpenRouterClient(
  opts: OpenRouterClientOptions,
): LlmClient {
  if (!opts.apiKey) throw new Error("OpenRouter API key is required");
  const timeoutMs = opts.timeoutMs ?? 60_000,
    maxRetries = opts.maxRetries ?? 2;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 0
  )
    throw new Error("Invalid OpenRouter timeout or retry count");
  const endpoint = `${(opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "")}/chat/completions`;
  const transport = opts.fetch ?? globalThis.fetch;
  const redact = (text: string) =>
    text
      .split(opts.apiKey)
      .join("[redacted]")
      .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");

  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("OpenRouter call timed out")),
        timeoutMs,
      );
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal;
      try {
        for (let attempt = 0; ; attempt++) {
          if (signal.aborted)
            throw new LlmClientError(
              controller.signal.aborted
                ? "OpenRouter call timed out"
                : "OpenRouter call aborted",
              controller.signal.aborted ? "timeout" : "aborted",
            );
          let response: Response, body: string;
          try {
            response = await transport(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${opts.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: request.model,
                messages: request.messages,
                temperature: request.temperature,
                max_tokens: request.maxOutputTokens,
                usage: { include: true },
                ...(request.jsonSchema
                  ? {
                      response_format: {
                        type: "json_schema",
                        json_schema: {
                          name: request.jsonSchema.name,
                          strict: true,
                          schema: request.jsonSchema.schema,
                        },
                      },
                      provider: { require_parameters: true },
                    }
                  : {}),
              }),
              signal,
            });
            body = await response.text();
          } catch (error) {
            if (signal.aborted)
              throw new LlmClientError(
                controller.signal.aborted
                  ? "OpenRouter call timed out"
                  : "OpenRouter call aborted",
                controller.signal.aborted ? "timeout" : "aborted",
              );
            if (attempt < maxRetries) {
              await delay(250 * 2 ** attempt, signal);
              continue;
            }
            throw new LlmClientError(
              `OpenRouter network error: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
              "network_error",
            );
          }
          if (!response.ok) {
            if (
              (response.status === 429 || response.status >= 500) &&
              attempt < maxRetries
            ) {
              await delay(250 * 2 ** attempt, signal);
              continue;
            }
            throw new LlmClientError(
              `OpenRouter HTTP ${response.status}: ${redact(body).replace(/\s+/g, " ").slice(0, 300)}`,
              `http_${response.status}`,
            );
          }
          let data: z.infer<typeof envelope>;
          try {
            data = envelope.parse(JSON.parse(body));
          } catch {
            throw new LlmClientError(
              "OpenRouter returned an invalid response envelope",
              "invalid_response",
            );
          }
          const usage = data.usage;
          const result: LlmResponse = {
            content: data.choices[0]!.message.content ?? "",
            provider: data.provider ?? "openrouter",
            model: data.model ?? request.model,
            providerRequestId: data.id ?? null,
            usage: {
              inputTokens: usage?.prompt_tokens ?? 0,
              outputTokens: usage?.completion_tokens ?? 0,
              cachedInputTokens:
                usage?.prompt_tokens_details?.cached_tokens ?? 0,
              cacheWriteTokens:
                usage?.prompt_tokens_details?.cache_write_tokens ??
                usage?.cache_write_tokens ??
                0,
              costMicroUsd: BigInt(Math.round((usage?.cost ?? 0) * 1e6)),
            },
            latencyMs: Math.round(performance.now() - started),
          };
          if (!result.content)
            throw new LlmClientError(
              "OpenRouter returned no text content",
              "empty_response",
              result,
            );
          return result;
        }
      } catch (error) {
        if (signal.aborted && !(error instanceof LlmClientError))
          throw new LlmClientError(
            controller.signal.aborted
              ? "OpenRouter call timed out"
              : "OpenRouter call aborted",
            controller.signal.aborted ? "timeout" : "aborted",
          );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
