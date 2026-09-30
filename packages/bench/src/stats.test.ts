import { expect, test } from "bun:test";
import { wilson, mean, percentile, disjoint } from "./stats";

test("Wilson 95% known values at zero, all and half successes", () => {
  expect(wilson(0, 10).low).toBeCloseTo(0, 6);
  expect(wilson(0, 10).high).toBeCloseTo(0.27754, 4);
  expect(wilson(10, 10).low).toBeCloseTo(0.72246, 4);
  expect(wilson(10, 10).high).toBeCloseTo(1, 6);
  expect(wilson(5, 10).low).toBeCloseTo(0.23659, 4);
  expect(wilson(5, 10).high).toBeCloseTo(0.76341, 4);
  expect(wilson(0, 0)).toEqual({ p: 0, low: 0, high: 1 });
});
test("means, interpolated percentiles and non-overlap flags", () => {
  expect(mean([1, 2, 3])).toBe(2);
  expect(percentile([3, 1, 2], 0.95)).toBeCloseTo(2.9);
  expect(percentile([], 0.5)).toBe(0);
  expect(mean([])).toBe(0);
  expect(disjoint(wilson(100, 100), wilson(0, 100))).toBe(true);
  expect(disjoint(wilson(5, 10), wilson(6, 10))).toBe(false);
});
