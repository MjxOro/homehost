import { describe, expect, test } from "bun:test";
import {
  SSH_PORT_MAX,
  SSH_PORT_MIN,
  ipv6ForInstance,
  pickFreePort,
  toSubdomain,
} from "./provisioning.js";

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
describe("ssh port pool", () => {
  test("picks the lowest free port and skips taken ones", () => {
    expect(pickFreePort([])).toBe(SSH_PORT_MIN);
    expect(pickFreePort([SSH_PORT_MIN, SSH_PORT_MIN + 1])).toBe(
      SSH_PORT_MIN + 2,
    );
  });

  test("returns null only when the whole pool is taken", () => {
    const full = Array.from(
      { length: SSH_PORT_MAX - SSH_PORT_MIN + 1 },
      (_, i) => SSH_PORT_MIN + i,
    );
    expect(pickFreePort(full)).toBeNull();
  });
});

describe("instance ipv6", () => {
  const uuid = "12345678-1234-4123-8123-123456789abc";
  test("derives a stable address from prefix and uuid", () => {
    const first = ipv6ForInstance("2a11:6c7:f35:ea", uuid);
    expect(first).toBe("2a11:6c7:f35:ea:8123:1234:5678:9abc");
    expect(ipv6ForInstance("2a11:6c7:f35:ea", uuid)).toBe(first);
  });

  test("skips reserved interface ids and rejects bad input", () => {
    expect(
      ipv6ForInstance(
        "2a11:6c7:f35:ea",
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toBe("2a11:6c7:f35:ea:8000:0000:0000:0002");
    expect(ipv6ForInstance("", uuid)).toBeNull();
    expect(ipv6ForInstance("not-a-prefix", uuid)).toBeNull();
    expect(ipv6ForInstance("2a11:6c7:f35:ea", "nope")).toBeNull();
  });
});
