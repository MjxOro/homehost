import { describe, expect, test } from "bun:test";
import { PortPool, toSubdomain } from "./provisioning.js";

describe("toSubdomain", () => {
  test("sanitizes to flat wildcard-safe name", () => {
    expect(toSubdomain("My Server!", "Alice_99", "lab.example.com")).toBe(
      "my-server-alice-99.lab.example.com",
    );
  });

  test("falls back on empty input", () => {
    expect(toSubdomain("!!!", "***", "lab.example.com")).toBe("srv-srv.lab.example.com");
  });
});

describe("PortPool", () => {
  test("reuses released ports, throws when exhausted", () => {
    const pool = new PortPool(31000, 31001);
    const a = pool.allocate();
    const b = pool.allocate();
    expect(a).toBe(31000);
    expect(b).toBe(31001);
    expect(() => pool.allocate()).toThrow("port pool exhausted");
    pool.release(a);
    expect(pool.available).toBe(1);
    expect(pool.allocate()).toBe(31000);
  });
});
