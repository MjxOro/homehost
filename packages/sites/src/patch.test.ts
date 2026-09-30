import { expect, test } from "bun:test";
import { applySpecPatch, SpecPatchError } from "./patch";
import { fixture } from "./fixtures.test-helper";

test("add, replace, remove and array append leave input unchanged", () => {
  const spec = fixture(),
    before = structuredClone(spec);
  const result = applySpecPatch(spec, [
    { op: "add", path: "/business/tagline", value: "Here to help" },
    { op: "replace", path: "/business/name", value: "Cedar Plumbing" },
    { op: "add", path: "/business/serviceArea/-", value: "Saanich" },
    { op: "remove", path: "/business/email" },
  ]);
  expect(result.business.name).toBe("Cedar Plumbing");
  expect(result.business.tagline).toBe("Here to help");
  expect(result.business.serviceArea).toEqual([
    "Victoria",
    "Oak Bay",
    "Saanich",
  ]);
  expect(result.business.email).toBeUndefined();
  expect(spec).toEqual(before);
});
test("move and copy use RFC array insertion and removal order", () => {
  const result = applySpecPatch(fixture(), [
    {
      op: "move",
      from: "/business/serviceArea/0",
      path: "/business/serviceArea/1",
    },
    {
      op: "copy",
      from: "/business/serviceArea/0",
      path: "/business/serviceArea/-",
    },
    { op: "copy", from: "/business/name", path: "/business/tagline" },
  ]);
  expect(result.business.serviceArea).toEqual([
    "Oak Bay",
    "Victoria",
    "Oak Bay",
  ]);
  expect(result.business.tagline).toBe(result.business.name);
});
test("JSON Pointer ~1 and ~0 escape keys", () => {
  const result = applySpecPatch(fixture(), [
    { op: "add", path: "/business/a~1b~0c", value: "Renamed business" },
    { op: "test", path: "/business/a~1b~0c", value: "Renamed business" },
    { op: "copy", from: "/business/a~1b~0c", path: "/business/name" },
    { op: "remove", path: "/business/a~1b~0c" },
  ]);
  expect(result.business.name).toBe("Renamed business");
});
test("test equality ignores object property order", () => {
  const spec = fixture();
  expect(
    applySpecPatch(spec, [
      {
        op: "test",
        path: "/theme",
        value: { fonts: "modern", preset: "ocean" },
      },
    ]),
  ).toEqual(spec);
});
test("failed test aborts without mutating input", () => {
  const spec = fixture(),
    before = structuredClone(spec);
  expect(() =>
    applySpecPatch(spec, [
      { op: "replace", path: "/business/name", value: "Changed" },
      { op: "test", path: "/business/name", value: "Original" },
    ]),
  ).toThrow("Test failed");
  expect(spec).toEqual(before);
});
test("invalid final spec reports validation issues", () => {
  try {
    applySpecPatch(fixture(), [{ op: "remove", path: "/pages/0" }]);
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SpecPatchError);
    expect((error as SpecPatchError).issues.length).toBeGreaterThan(0);
  }
});
test.each([
  "/business/missing",
  "/pages/01",
  "/pages/-",
  "/pages/99",
  "/business/name/child",
  "/business/~2",
  "/__proto__/polluted",
  "business/name",
])("rejects nonexistent or invalid pointer %s", (path) => {
  expect(() => applySpecPatch(fixture(), [{ op: "remove", path }])).toThrow(
    SpecPatchError,
  );
});
test("rejects move into a descendant", () => {
  expect(() =>
    applySpecPatch(fixture(), [
      { op: "move", from: "/pages", path: "/pages/0/sections" },
    ]),
  ).toThrow("descendant");
});
test("handles whole-document replacement and rejects removal", () => {
  const replacement = fixture();
  replacement.business.name = "New business";
  expect(
    applySpecPatch(fixture(), [
      { op: "replace", path: "", value: replacement },
    ]),
  ).toEqual(replacement);
  expect(() => applySpecPatch(fixture(), [{ op: "remove", path: "" }])).toThrow(
    "invalid",
  );
});
test("a removed root is absent, and only add can restore it", () => {
  const spec = fixture();
  expect(
    applySpecPatch(spec, [
      { op: "remove", path: "" },
      { op: "add", path: "", value: spec },
    ]),
  ).toEqual(spec);
  expect(() =>
    applySpecPatch(spec, [
      { op: "remove", path: "" },
      { op: "test", path: "", value: null },
      { op: "add", path: "", value: spec },
    ]),
  ).toThrow("does not exist");
  expect(() =>
    applySpecPatch(spec, [
      { op: "remove", path: "" },
      { op: "replace", path: "", value: spec },
    ]),
  ).toThrow("does not exist");
});
test("patch values are copied and non-JSON values rejected", () => {
  const value = ["Saanich"];
  const result = applySpecPatch(fixture(), [
    { op: "replace", path: "/business/serviceArea", value },
  ]);
  value.push("Victoria");
  expect(result.business.serviceArea).toEqual(["Saanich"]);
  expect(() =>
    applySpecPatch(fixture(), [
      { op: "add", path: "/business/tagline", value: NaN },
    ]),
  ).toThrow("JSON");
});
