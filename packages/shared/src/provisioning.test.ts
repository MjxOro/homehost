import { describe, expect, test } from "bun:test";
import { toSubdomain } from "./provisioning.js";

const id = "12345678-1234-4123-8123-123456789abc";
const base = "lab.example.test";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

describe("flat reserved hostnames", () => {
  test("user punctuation cannot create additional subdomain levels", () => {
    const name = toSubdomain("My.Server!", "Alice_99", base, id);
    expect(name.endsWith(`.${base}`)).toBe(true);
    expect(name.split(".").length).toBe(base.split(".").length + 1);
    expect(name.split(".")[0]).toMatch(dnsLabel);
    expect(toSubdomain("!!!", "***", base, id).split(".")[0]).toMatch(dnsLabel);
  });

  test("long names and owners stay within the 63-byte DNS label limit", () => {
    const label = toSubdomain(
      "long-name-".repeat(10),
      "owner-name-".repeat(10),
      base,
      id,
    ).split(".")[0];
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(dnsLabel);
  });

  test("colliding slugs and UUID prefixes still produce distinct reservations", () => {
    const first = toSubdomain("Minecraft!", "Alice", base, id);
    const second = toSubdomain(
      "Minecraft?",
      "Alice",
      base,
      "12345678-1234-4123-8123-123456789abd",
    );
    expect(first).not.toBe(second);
  });
});
