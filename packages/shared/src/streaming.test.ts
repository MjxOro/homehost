import { describe, expect, test } from "bun:test";
import {
  STREAM_MOBILE_MAX_MBPS,
  STREAM_PROFILES,
  STREAM_RTT_DEGRADE_MS,
  STREAM_STANDARD_MAX_MBPS,
  classifyBandwidth,
  estimateDownlinkMbps,
  recommendStreamProfile,
} from "./streaming.js";
import type { StreamTier } from "./streaming.js";

const TIERS: StreamTier[] = ["mobile", "standard", "sharp"];

describe("estimateDownlinkMbps", () => {
  test("converts a timed download to Mbps", () => {
    expect(estimateDownlinkMbps(125_000, 1000)).toBe(1);
    expect(estimateDownlinkMbps(1_000_000, 1000)).toBe(8);
  });

  test("rejects useless inputs", () => {
    expect(estimateDownlinkMbps(0, 1000)).toBeNull();
    expect(estimateDownlinkMbps(1000, 0)).toBeNull();
    expect(estimateDownlinkMbps(-5, 1000)).toBeNull();
    expect(estimateDownlinkMbps(1000, -1)).toBeNull();
    expect(estimateDownlinkMbps(Number.NaN, 1000)).toBeNull();
    expect(estimateDownlinkMbps(1000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("classifyBandwidth", () => {
  test("holds tier boundaries", () => {
    expect(classifyBandwidth(STREAM_MOBILE_MAX_MBPS - 0.001)).toBe("mobile");
    expect(classifyBandwidth(STREAM_MOBILE_MAX_MBPS)).toBe("standard");
    expect(classifyBandwidth(STREAM_STANDARD_MAX_MBPS)).toBe("standard");
    expect(classifyBandwidth(STREAM_STANDARD_MAX_MBPS + 0.001)).toBe("sharp");
  });

  test("fails safe on garbage", () => {
    expect(classifyBandwidth(Number.NaN)).toBe("mobile");
    expect(classifyBandwidth(-20)).toBe("mobile");
  });
});

describe("recommendStreamProfile", () => {
  test("weak links start mobile", () => {
    const rec = recommendStreamProfile({ downMbps: 8 });
    expect(rec.tier).toBe("mobile");
    expect(rec.settings).toBe(STREAM_PROFILES.mobile);
    expect(rec.settings.frameRate).toBeLessThanOrEqual(30);
  });

  test("fast links earn sharp", () => {
    const rec = recommendStreamProfile({ downMbps: 50 });
    expect(rec.tier).toBe("sharp");
    expect(rec.settings).toBe(STREAM_PROFILES.sharp);
  });

  test("high RTT drops exactly one tier", () => {
    expect(
      recommendStreamProfile({ downMbps: 50, rttMs: STREAM_RTT_DEGRADE_MS + 1 })
        .tier,
    ).toBe("standard");
    expect(
      recommendStreamProfile({ downMbps: 20, rttMs: STREAM_RTT_DEGRADE_MS + 1 })
        .tier,
    ).toBe("mobile");
    expect(
      recommendStreamProfile({
        downMbps: 5,
        rttMs: STREAM_RTT_DEGRADE_MS + 500,
      }).tier,
    ).toBe("mobile");
  });

  test("RTT at the limit does not degrade", () => {
    expect(
      recommendStreamProfile({ downMbps: 50, rttMs: STREAM_RTT_DEGRADE_MS })
        .tier,
    ).toBe("sharp");
  });

  test("unmeasured links fail safe with a reason", () => {
    for (const downMbps of [Number.NaN, 0, -3]) {
      const rec = recommendStreamProfile({ downMbps });
      expect(rec.tier).toBe("mobile");
      expect(rec.settings).toBe(STREAM_PROFILES.mobile);
      expect(rec.reason).toMatch(/unmeasured/);
    }
  });
});

describe("STREAM_PROFILES", () => {
  test("every tier stays inside KasmVNC flag ranges", () => {
    for (const tier of TIERS) {
      const s = STREAM_PROFILES[tier];
      expect(s.frameRate).toBeGreaterThanOrEqual(1);
      expect(s.frameRate).toBeLessThanOrEqual(60);
      expect(s.dynamicQualityMin).toBeGreaterThanOrEqual(0);
      expect(s.dynamicQualityMax).toBeLessThanOrEqual(9);
      expect(s.dynamicQualityMin).toBeLessThanOrEqual(s.dynamicQualityMax);
      expect(s.videoTime).toBeGreaterThanOrEqual(0);
      expect(s.videoArea).toBeGreaterThanOrEqual(0);
      expect(s.videoArea).toBeLessThanOrEqual(100);
      expect(s.treatLossless).toBeGreaterThanOrEqual(0);
      expect(s.treatLossless).toBeLessThanOrEqual(10);
      expect(s.maxVideoResolution).toMatch(/^\d+x\d+$/);
      expect(s.videoScaling).toBeGreaterThanOrEqual(0);
      expect(s.videoScaling).toBeLessThanOrEqual(2);
    }
  });

  test("quality never rises as the link weakens", () => {
    const { mobile, standard, sharp } = STREAM_PROFILES;
    for (const [weaker, stronger] of [
      [mobile, standard],
      [standard, sharp],
    ] as const) {
      expect(stronger.frameRate).toBeGreaterThanOrEqual(weaker.frameRate);
      expect(stronger.dynamicQualityMax).toBeGreaterThanOrEqual(
        weaker.dynamicQualityMax,
      );
      expect(stronger.dynamicQualityMin).toBeGreaterThanOrEqual(
        weaker.dynamicQualityMin,
      );
    }
  });
});
