import { describe, expect, test } from "bun:test";
import {
  dohHasAaaa,
  normalizeIpv6,
  pollChecks,
  sameIpv6,
  type ReadinessCheck,
} from "./readiness.js";

const ADDR = "2001:db8:1:2:abcd:ef01:2345:6789";

describe("ipv6 comparison", () => {
  test("compressed, expanded, padded and upper-case spellings match", () => {
    expect(
      sameIpv6("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"),
    ).toBe(true);
    expect(sameIpv6("2001:DB8:0:0:0:0:0:1", "2001:db8::1")).toBe(true);
    expect(sameIpv6("::", "0:0:0:0:0:0:0:0")).toBe(true);
    expect(normalizeIpv6("2001:db8::1")).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    );
  });

  test("different addresses and look-alike prefixes do not match", () => {
    expect(sameIpv6("2001:db8::1", "2001:db8::2")).toBe(false);
    expect(sameIpv6("2001:db8::1", "2001:db8:1::")).toBe(false);
  });

  test("malformed text never matches, even against itself", () => {
    for (const bad of [
      "",
      "2001:db8::1::2",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8::",
      "12345::1",
      "::ffff:1.2.3.4",
      ":1:2:3:4:5:6:7",
      "gggg::1",
    ]) {
      expect(normalizeIpv6(bad)).toBeNull();
      expect(sameIpv6(bad, bad)).toBe(false);
    }
  });
});

describe("DoH AAAA answer", () => {
  const answer = (data: string, type = 28) => ({
    name: "box.example.test",
    type,
    TTL: 120,
    data,
  });

  test("visible when an AAAA answer equals the expected address in any spelling", () => {
    const body = { Status: 0, Answer: [answer(ADDR)] };
    expect(dohHasAaaa(body, ADDR)).toBe(true);
    expect(
      dohHasAaaa(
        { Status: 0, Answer: [answer("2001:db8::1")] },
        "2001:0db8:0:0:0:0:0:1",
      ),
    ).toBe(true);
  });

  test("NXDOMAIN and empty NOERROR answers are not visible", () => {
    expect(dohHasAaaa({ Status: 3, Authority: [{ type: 6 }] }, ADDR)).toBe(
      false,
    );
    expect(dohHasAaaa({ Status: 0 }, ADDR)).toBe(false);
    expect(dohHasAaaa({ Status: 0, Answer: [] }, ADDR)).toBe(false);
  });

  test("a stale or foreign address, or a non-AAAA record, is not visible", () => {
    expect(
      dohHasAaaa({ Status: 0, Answer: [answer("2001:db8::9")] }, ADDR),
    ).toBe(false);
    expect(dohHasAaaa({ Status: 0, Answer: [answer(ADDR, 5)] }, ADDR)).toBe(
      false,
    );
    expect(
      dohHasAaaa(
        { Status: 0, Answer: [answer("other.example.test", 5)] },
        ADDR,
      ),
    ).toBe(false);
  });

  test("malformed bodies are not visible instead of throwing", () => {
    for (const body of [
      null,
      undefined,
      "x",
      7,
      [],
      { Status: 0, Answer: "x" },
    ]) {
      expect(dohHasAaaa(body, ADDR)).toBe(false);
    }
    expect(dohHasAaaa({ Status: 0, Answer: [null, 3, {}] }, ADDR)).toBe(false);
  });
});

describe("pollChecks", () => {
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    };
  }

  test("resolves once every check has passed and does not re-run passed checks", async () => {
    const c = clock();
    let tcpRuns = 0;
    let dnsRuns = 0;
    const checks: ReadinessCheck[] = [
      { failure: "tcp", run: async () => ++tcpRuns >= 1 },
      { failure: "dns", run: async () => ++dnsRuns >= 3 },
    ];
    await pollChecks(checks, { timeoutMs: 60_000, intervalMs: 2_000, ...c });
    expect(tcpRuns).toBe(1);
    expect(dnsRuns).toBe(3);
    expect(c.slept).toEqual([2_000, 2_000]);
  });

  test("timeout names only the checks that never passed", async () => {
    const c = clock();
    const checks: ReadinessCheck[] = [
      {
        failure: "box not reachable over IPv6 at [::1]:22",
        run: async () => true,
      },
      { failure: "AAAA not visible on public DNS", run: async () => false },
    ];
    const error = await pollChecks(checks, {
      timeoutMs: 5_000,
      intervalMs: 2_000,
      ...c,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("AAAA not visible on public DNS");
    // Last sleep is clipped to the remaining budget rather than overshooting.
    expect(c.slept).toEqual([2_000, 2_000, 1_000]);
  });

  test("a throwing check counts as failing and is retried", async () => {
    const c = clock();
    let runs = 0;
    await pollChecks(
      [
        {
          failure: "dns",
          run: async () => {
            if (++runs < 2) throw new Error("network down");
            return true;
          },
        },
      ],
      { timeoutMs: 10_000, intervalMs: 2_000, ...c },
    );
    expect(runs).toBe(2);
  });

  test("an exhausted budget still runs every check once", async () => {
    const c = clock();
    let runs = 0;
    await pollChecks([{ failure: "tcp", run: async () => ++runs > 0 }], {
      timeoutMs: 0,
      intervalMs: 2_000,
      ...c,
    });
    expect(runs).toBe(1);
    expect(c.slept).toEqual([]);
  });
});
