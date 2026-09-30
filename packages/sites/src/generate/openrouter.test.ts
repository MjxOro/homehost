import { expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createOpenRouterClient, LlmClientError } from "./openrouter";
import type { LlmRequest } from "./types";

const request: LlmRequest = {
  model: "cheap",
  messages: [{ role: "user", content: "JSON please" }],
  temperature: 0.2,
  maxOutputTokens: 100,
  jsonSchema: { name: "result", schema: { type: "object", properties: {} } },
};
function recorded(overrides: object = {}) {
  return {
    id: "gen-recorded",
    provider: "Google",
    model: "served-model",
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: {
      prompt_tokens: 123,
      completion_tokens: 45,
      cost: 0.0012346,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    },
    ...overrides,
  };
}
const transport = (
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => fn as typeof globalThis.fetch;
const key = () => randomBytes(24).toString("hex");

test("OpenRouter sends strict structured output and maps recorded billing metadata", async () => {
  const apiKey = key();
  let sent: any;
  const client = createOpenRouterClient({
    apiKey,
    fetch: transport(async (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${apiKey}`,
      );
      expect(init?.method).toBe("POST");
      sent = JSON.parse(String(init?.body));
      return Response.json(recorded());
    }),
  });
  const response = await client.complete(request);
  expect(sent.response_format).toEqual({
    type: "json_schema",
    json_schema: {
      name: "result",
      strict: true,
      schema: request.jsonSchema!.schema,
    },
  });
  expect(sent.usage).toEqual({ include: true });
  expect(sent.provider).toEqual({ require_parameters: true });
  expect(sent.max_tokens).toBe(100);
  expect(response).toMatchObject({
    provider: "Google",
    model: "served-model",
    providerRequestId: "gen-recorded",
    content: '{"ok":true}',
    usage: {
      inputTokens: 123,
      outputTokens: 45,
      cachedInputTokens: 20,
      cacheWriteTokens: 10,
      costMicroUsd: 1235n,
    },
  });
  expect(response.latencyMs).toBeGreaterThanOrEqual(0);
});
test("optional response metadata defaults to zero and requested model when cost is reported", async () => {
  const response = await createOpenRouterClient({
    apiKey: key(),
    baseUrl: "https://router.internal/v1/",
    fetch: transport(async (url, init) => {
      expect(url).toBe("https://router.internal/v1/chat/completions");
      expect(JSON.parse(String(init?.body)).response_format).toBeUndefined();
      return Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { cost: 0 },
      });
    }),
  }).complete({ model: "requested", messages: [] });
  expect(response).toMatchObject({
    provider: "openrouter",
    model: "requested",
    providerRequestId: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0n,
    },
  });
});
test("maps top-level cache writes when token details are missing", async () => {
  const response = await createOpenRouterClient({
    apiKey: key(),
    fetch: transport(async () =>
      Response.json(
        recorded({ usage: { cost: 0.000001, cache_write_tokens: 7 } }),
      ),
    ),
  }).complete(request);
  expect(response.usage.cacheWriteTokens).toBe(7);
  expect(response.usage.costMicroUsd).toBe(1n);
});
test.each([
  { label: "no usage", usage: undefined, inputTokens: 0 },
  {
    label: "usage without cost",
    usage: { prompt_tokens: 40, completion_tokens: 5 },
    inputTokens: 40,
  },
])(
  "a successful response with $label is a missing_usage error, not a free call",
  async ({ usage, inputTokens }) => {
    const client = createOpenRouterClient({
      apiKey: key(),
      fetch: transport(async () => Response.json(recorded({ usage }))),
    });
    await expect(client.complete(request)).rejects.toMatchObject({
      code: "missing_usage",
      response: {
        content: '{"ok":true}',
        providerRequestId: "gen-recorded",
        usage: { inputTokens, costMicroUsd: 0n },
      },
    });
  },
);
test("an invalid envelope still carries reported usage and cost", async () => {
  const client = createOpenRouterClient({
    apiKey: key(),
    fetch: transport(async () => Response.json(recorded({ choices: [] }))),
  });
  await expect(client.complete(request)).rejects.toMatchObject({
    code: "invalid_response",
    response: {
      providerRequestId: "gen-recorded",
      usage: { inputTokens: 123, costMicroUsd: 1235n },
    },
  });
});
test.each([429, 503])("retries HTTP %i with backoff", async (status) => {
  let attempts = 0;
  const response = await createOpenRouterClient({
    apiKey: key(),
    maxRetries: 1,
    fetch: transport(async () =>
      ++attempts === 1
        ? new Response("Try later", { status })
        : Response.json(recorded()),
    ),
  }).complete(request);
  expect(attempts).toBe(2);
  expect(response.providerRequestId).toBe("gen-recorded");
});
// Records every backoff wait and runs it immediately; only the call deadline
// timer (timeoutMs) keeps its real duration.
async function recordWaits(
  timeoutMs: number,
  run: () => unknown,
): Promise<number[]> {
  const real = globalThis.setTimeout,
    waits: number[] = [];
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms === timeoutMs) return real(fn, ms);
    waits.push(ms ?? 0);
    return real(fn, 0);
  }) as typeof setTimeout);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return waits;
}
test.each([
  { status: 429, header: "2", min: 2000, max: 2000 },
  {
    status: 503,
    header: new Date(Date.now() + 5000).toUTCString(),
    min: 3000,
    max: 5000,
  },
  { status: 429, header: "3600", min: 10_000, max: 10_000 },
  { status: 503, header: null, min: 250, max: 250 },
  { status: 502, header: "2", min: 250, max: 250 },
])(
  "HTTP $status with Retry-After $header waits between $min and $max ms",
  async ({ status, header, min, max }) => {
    let attempts = 0;
    const client = createOpenRouterClient({
      apiKey: key(),
      timeoutMs: 30_000,
      fetch: transport(async () =>
        ++attempts === 1
          ? new Response("Try later", {
              status,
              headers: header ? { "Retry-After": header } : {},
            })
          : Response.json(recorded()),
      ),
    });
    const waits = await recordWaits(30_000, () => client.complete(request));
    expect(attempts).toBe(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThanOrEqual(min);
    expect(waits[0]!).toBeLessThanOrEqual(max);
  },
);
test("a Retry-After beyond the call deadline fails with the HTTP status instead of waiting", async () => {
  let attempts = 0;
  const client = createOpenRouterClient({
    apiKey: key(),
    timeoutMs: 5000,
    fetch: transport(async () => {
      attempts++;
      return new Response("Slow down", {
        status: 429,
        headers: { "Retry-After": "8" },
      });
    }),
  });
  const waits = await recordWaits(5000, () =>
    expect(client.complete(request)).rejects.toMatchObject({
      code: "http_429",
    }),
  );
  expect(attempts).toBe(1);
  expect(waits).toEqual([]);
});
test("retries network failures and body-stream failures", async () => {
  let attempts = 0;
  const result = await createOpenRouterClient({
    apiKey: key(),
    fetch: transport(async () => {
      if (++attempts === 1) throw new Error("Connection reset");
      if (attempts === 2)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("Body reset"));
            },
          }),
        );
      return Response.json(recorded());
    }),
  }).complete(request);
  expect(attempts).toBe(3);
  expect(result.provider).toBe("Google");
});
test("HTTP errors include status and a short key-free excerpt without retrying 400", async () => {
  const apiKey = key();
  let attempts = 0;
  const client = createOpenRouterClient({
    apiKey,
    fetch: transport(async () => {
      attempts++;
      return new Response(
        `Rejected Bearer ${apiKey} ${apiKey} ${"x".repeat(1000)}`,
        { status: 400 },
      );
    }),
  });
  try {
    await client.complete(request);
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(LlmClientError);
    expect((error as Error).message).toContain("400");
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message.length).toBeLessThan(350);
    expect((error as LlmClientError).code).toBe("http_400");
  }
  expect(attempts).toBe(1);
});
test("retry limit and network errors never reveal the key", async () => {
  const apiKey = key();
  let attempts = 0;
  const client = createOpenRouterClient({
    apiKey,
    maxRetries: 0,
    fetch: transport(async () => {
      attempts++;
      throw new Error(`Failed with ${apiKey}`);
    }),
  });
  try {
    await client.complete(request);
    throw new Error("Expected failure");
  } catch (error) {
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as LlmClientError).code).toBe("network_error");
  }
  expect(attempts).toBe(1);
});
test("timeout aborts transport without retry", async () => {
  let attempts = 0;
  const client = createOpenRouterClient({
    apiKey: key(),
    timeoutMs: 10,
    fetch: transport(async (_, init) => {
      attempts++;
      return new Promise((_, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        ),
      );
    }),
  });
  await expect(client.complete(request)).rejects.toMatchObject({
    code: "timeout",
  });
  expect(attempts).toBe(1);
});
test("external abort cancels retries and an already aborted signal makes no requests", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = createOpenRouterClient({
    apiKey: key(),
    signal: controller.signal,
    fetch: transport(async () => {
      attempts++;
      controller.abort();
      return new Response("Busy", { status: 429 });
    }),
  });
  await expect(client.complete(request)).rejects.toMatchObject({
    code: "aborted",
  });
  await expect(client.complete(request)).rejects.toMatchObject({
    code: "aborted",
  });
  expect(attempts).toBe(1);
});
test("empty content preserves known billed usage in the error", async () => {
  const client = createOpenRouterClient({
    apiKey: key(),
    fetch: transport(async () =>
      Response.json(recorded({ choices: [{ message: { content: null } }] })),
    ),
  });
  await expect(client.complete(request)).rejects.toMatchObject({
    code: "empty_response",
    response: {
      usage: { costMicroUsd: 1235n },
      providerRequestId: "gen-recorded",
    },
  });
});
test("invalid response envelopes fail with a key-free diagnostic", async () => {
  const apiKey = key();
  const client = createOpenRouterClient({
    apiKey,
    fetch: transport(async () => new Response(apiKey)),
  });
  await expect(client.complete(request)).rejects.toMatchObject({
    code: "invalid_response",
    message: "OpenRouter returned an invalid response envelope",
  });
});
