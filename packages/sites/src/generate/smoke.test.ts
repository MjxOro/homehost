import { expect, test } from "bun:test";
import { costSummary, formatMicroUsd } from "./smoke";
import { SiteBrief } from "./types";
import type { LlmCallRecord } from "./types";

test("smoke formats integer micro-dollar totals without float rounding", () => {
  expect(formatMicroUsd(0n)).toBe("$0.000000");
  expect(formatMicroUsd(1234567n)).toBe("$1.234567");
  const call: LlmCallRecord = {
    stage: "plan",
    provider: "scripted",
    model: "small",
    providerRequestId: null,
    promptHash: "hash",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    cacheWriteTokens: 5,
    costMicroUsd: 1234n,
    latencyMs: 5,
    status: "error",
    errorCode: "invalid_json",
  };
  expect(
    costSummary([call, { ...call, status: "ok", costMicroUsd: 2n }], 3),
  ).toBe(
    "Calls: 2 (3 HTTP attempts)\nTokens: 200 input, 40 output, 20 cached, 10 cache writes\nTotal cost: $0.001236 USD",
  );
});
test("example generation brief validates without a network call", async () => {
  const input: unknown = await Bun.file(
    new URL("../../examples/briefs/plumber.json", import.meta.url),
  ).json();
  expect(SiteBrief.safeParse(input).success).toBe(true);
});
