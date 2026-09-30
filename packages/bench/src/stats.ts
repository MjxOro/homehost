export type Interval = { p: number; low: number; high: number };

/** Wilson score interval for a binomial proportion (default 95%). */
export function wilson(passes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { p: 0, low: 0, high: 1 };
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    p,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

export function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Linear-interpolated percentile, q in [0, 1]. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** True when two intervals share no point, i.e. the difference is beyond noise. */
export function disjoint(a: Interval, b: Interval): boolean {
  return a.high < b.low || b.high < a.low;
}
