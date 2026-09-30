import { expect, test } from "bun:test";
import {
  SpendGuard,
  SpendCapExceeded,
  usdToMicro,
  withSpendGuard,
} from "./spend";
import { withCache } from "./cache";
import { LlmClientError } from "./pipeline";
import { request, response, temporary } from "./fixtures.test-helper";

test("spend guard blocks the call starting at the cap", async () => {
  let calls = 0;
  const guard = new SpendGuard(2000n);
  const llm = withSpendGuard(
    {
      complete: async () => {
        calls++;
        return response();
      },
    },
    guard,
  );
  await llm.complete(request);
  await llm.complete(request);
  await expect(llm.complete(request)).rejects.toBeInstanceOf(SpendCapExceeded);
  expect(calls).toBe(2);
  expect(guard.spentMicroUsd).toBe(2000n);
  expect(guard.tripped).toBe(true);
});

test("zero cap permits cache hits but no live calls", async () => {
  const temp = await temporary();
  try {
    await withCache(
      { complete: async () => response() },
      { dir: temp.dir, mode: "record" },
    ).complete(request);
    const guard = new SpendGuard(0n);
    const llm = withCache(
      withSpendGuard(
        {
          complete: async () => {
            throw new Error("No calls");
          },
        },
        guard,
      ),
      { dir: temp.dir, mode: "replay" },
    );
    await llm.complete(request);
    expect(guard.spentMicroUsd).toBe(0n);
  } finally {
    await temp.cleanup();
  }
});

test("known billed errors count toward spend; invalid amounts are rejected", async () => {
  const guard = new SpendGuard(1000n);
  const error = Object.assign(new Error("Unusable billed answer"), {
    response: response(),
  });
  const llm = withSpendGuard(
    {
      complete: async () => {
        throw error;
      },
    },
    guard,
  );
  await expect(llm.complete(request)).rejects.toThrow(error.message);
  expect(guard.spentMicroUsd).toBe(1000n);
  await expect(llm.complete(request)).rejects.toBeInstanceOf(SpendCapExceeded);
  expect(usdToMicro(0.123456)).toBe(123456n);
  for (const usd of [-1, Infinity, NaN])
    expect(() => usdToMicro(usd)).toThrow();
});

test("unknown usage cost blocks further live calls rather than treating them as free", async () => {
  const guard = new SpendGuard(100000n);
  let calls = 0;
  const llm = withSpendGuard(
    {
      complete: async () => {
        calls++;
        throw new LlmClientError(
          "Missing provider cost",
          "missing_usage",
          response(0n),
        );
      },
    },
    guard,
  );
  await expect(llm.complete(request)).rejects.toThrow("Missing provider cost");
  await expect(llm.complete(request)).rejects.toThrow(
    "actual spend is unknown",
  );
  expect(calls).toBe(1);
  expect(guard.unknownSpend).toBe(true);
});
