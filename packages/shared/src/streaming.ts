/** Client-link preflight for remote-desktop streaming. Pure, no I/O.
 *
 * Measure on the viewer's link (mobile data lands ~5-15 Mbps), then apply
 * the recommended KasmVNC settings before loading the canvas. KasmVNC still
 * auto-weakens inside the session via its dynamic-quality range; this picks
 * the starting profile so weak links never begin at 60 fps / top quality.
 */

export type StreamTier = "mobile" | "standard" | "sharp";

/** KasmVNC `Xvnc` flags for one display, mirroring the desk2 bakeoff. */
export interface KasmStreamSettings {
  frameRate: number;
  dynamicQualityMin: number;
  dynamicQualityMax: number;
  videoTime: number;
  videoArea: number;
  treatLossless: number;
  maxVideoResolution: string;
  videoScaling: number;
}

export interface StreamMeasurement {
  /** Client downstream in Mbps. Non-finite or <= 0 means unmeasured. */
  downMbps: number;
  /** Round-trip time in ms, when known. Past the limit drops one tier. */
  rttMs?: number;
}

export interface StreamRecommendation {
  tier: StreamTier;
  /** Reference into STREAM_PROFILES, never a copy. */
  settings: KasmStreamSettings;
  reason: string;
}

/** At or above this stays off the mobile profile. */
export const STREAM_MOBILE_MAX_MBPS = 10;
/** At or above this earns the sharp profile. */
export const STREAM_STANDARD_MAX_MBPS = 30;
/** RTT past this drops the recommendation one tier. */
export const STREAM_RTT_DEGRADE_MS = 150;

export const STREAM_PROFILES: Record<StreamTier, KasmStreamSettings> = {
  mobile: {
    frameRate: 30,
    dynamicQualityMin: 5,
    dynamicQualityMax: 7,
    videoTime: 3,
    videoArea: 15,
    treatLossless: 7,
    maxVideoResolution: "1280x720",
    videoScaling: 2,
  },
  standard: {
    frameRate: 30,
    dynamicQualityMin: 7,
    dynamicQualityMax: 9,
    videoTime: 5,
    videoArea: 25,
    treatLossless: 7,
    maxVideoResolution: "1280x720",
    videoScaling: 0,
  },
  sharp: {
    frameRate: 60,
    dynamicQualityMin: 8,
    dynamicQualityMax: 9,
    videoTime: 5,
    videoArea: 45,
    treatLossless: 7,
    maxVideoResolution: "1280x720",
    videoScaling: 0,
  },
};
/** Mbps for a timed same-origin download, or null when inputs are useless. */
export function estimateDownlinkMbps(
  bytes: number,
  elapsedMs: number,
): number | null {
  if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs)) return null;
  if (bytes <= 0 || elapsedMs <= 0) return null;
  return (bytes * 8) / elapsedMs / 1000;
}

/** Tier for a measured downstream. Unmeasured links land on mobile (safe). */
export function classifyBandwidth(downMbps: number): StreamTier {
  if (!Number.isFinite(downMbps) || downMbps < STREAM_MOBILE_MAX_MBPS)
    return "mobile";
  if (downMbps <= STREAM_STANDARD_MAX_MBPS) return "standard";
  return "sharp";
}
export function recommendStreamProfile(
  measurement: StreamMeasurement,
): StreamRecommendation {
  const { downMbps, rttMs } = measurement;
  if (!Number.isFinite(downMbps) || downMbps <= 0) {
    return {
      tier: "mobile",
      settings: STREAM_PROFILES.mobile,
      reason: "unmeasured link — safe mobile default",
    };
  }
  let tier = classifyBandwidth(downMbps);
  let reason = `${downMbps} Mbps`;
  if (
    rttMs !== undefined &&
    Number.isFinite(rttMs) &&
    rttMs > STREAM_RTT_DEGRADE_MS
  ) {
    tier = tier === "sharp" ? "standard" : "mobile";
    reason += ` with ${rttMs} ms RTT — dropped one tier`;
  }
  return { tier, settings: STREAM_PROFILES[tier], reason };
}
