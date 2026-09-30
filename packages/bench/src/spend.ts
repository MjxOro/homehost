import type { LlmClient, LlmRequest, LlmResponse } from "@homehost/sites";

export class SpendCapExceeded extends Error {
  constructor(
    readonly spentMicroUsd: bigint,
    readonly capMicroUsd: bigint,
  ) {
    super(
      `bench spend cap reached: spent ${spentMicroUsd} of ${capMicroUsd} micro-USD`,
    );
    this.name = "SpendCapExceeded";
  }
}

export class UnknownSpend extends Error {
  constructor() {
    super(
      "bench stopped: provider did not report usage cost; actual spend is unknown",
    );
    this.name = "UnknownSpend";
  }
}

/**
 * Running total of live (non-cached) spend, shared by every call in a run.
 * A call that would START at or after the cap throws. Calls already in flight
 * when the cap is crossed finish, so the final total can exceed the cap by at
 * most the cost of the in-flight calls.
 */
export class SpendGuard {
  spentMicroUsd = 0n;
  tripped = false;
  unknownSpend = false;
  constructor(readonly capMicroUsd: bigint) {
    if (capMicroUsd < 0n) throw new Error("Spend cap must be nonnegative");
  }
}

export function usdToMicro(usd: number): bigint {
  if (
    !Number.isFinite(usd) ||
    usd < 0 ||
    !Number.isSafeInteger(Math.round(usd * 1_000_000))
  )
    throw new Error("Invalid USD amount");
  return BigInt(Math.round(usd * 1_000_000));
}

/** Wrap the LIVE client (below the cache) so only real spend is counted. */
export function withSpendGuard(inner: LlmClient, guard: SpendGuard): LlmClient {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      if (guard.unknownSpend) throw new UnknownSpend();
      if (guard.spentMicroUsd >= guard.capMicroUsd) {
        guard.tripped = true;
        throw new SpendCapExceeded(guard.spentMicroUsd, guard.capMicroUsd);
      }
      try {
        const response = await inner.complete(request);
        guard.spentMicroUsd += response.usage.costMicroUsd;
        return response;
      } catch (error) {
        if ((error as { code?: string })?.code === "missing_usage")
          guard.unknownSpend = true;
        const billed = (
          error as { response?: { usage?: { costMicroUsd?: bigint } } }
        )?.response?.usage?.costMicroUsd;
        if (typeof billed === "bigint") guard.spentMicroUsd += billed;
        throw error;
      }
    },
  };
}
