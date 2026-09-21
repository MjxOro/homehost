import { describe, expect, test } from "bun:test";
import { TIER_QUOTAS } from "./control-plane.js";
import { PLANS } from "./plans.js";
import { toDesktopHostname, toSubdomain } from "./provisioning.js";

const base = "lab.example.test";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const idA = "12345678-1234-4123-8123-123456789abc";
const idB = "22345678-1234-4123-8123-123456789abc";

describe("toDesktopHostname", () => {
  test("appends -vnc as a single flat DNS level", () => {
    const host = toDesktopHostname(toSubdomain("Desk", "Alice", base, idA));
    expect(host.endsWith(`.${base}`)).toBe(true);
    expect(host.split(".").length).toBe(base.split(".").length + 1);
    const label = host.split(".")[0] ?? "";
    expect(label.endsWith("-vnc")).toBe(true);
    expect(label).toMatch(dnsLabel);
  });

  test("59-char labels grow to exactly 63, longer labels truncate to 63", () => {
    const atBoundary = toDesktopHostname(`${"a".repeat(59)}.${base}`);
    expect((atBoundary.split(".")[0] ?? "").length).toBe(63);
    const over = toDesktopHostname(
      toSubdomain("long-name-".repeat(10), "owner-name-".repeat(10), base, idA),
    );
    const overLabel = over.split(".")[0] ?? "";
    expect(overLabel.length).toBe(63);
    expect(overLabel).toMatch(dnsLabel);
    expect(overLabel.endsWith("-vnc")).toBe(true);
  });

  test("near-colliding reservations keep distinct desktop hostnames", () => {
    const first = toDesktopHostname(toSubdomain("Minecraft!", "Alice", base, idA));
    const second = toDesktopHostname(toSubdomain("Minecraft?", "Alice", base, idB));
    expect(first).not.toBe(second);
    expect(second.endsWith("-vnc." + base)).toBe(true);
  });
});

describe("desktop plans", () => {
  test("desktop-ubuntu carries the xfce bake on ubuntu/cloud", () => {
    const plan = PLANS.find((p) => p.id === "desktop-ubuntu");
    expect(plan).toMatchObject({
      cpu: 2,
      memoryMb: 2048,
      diskGb: 20,
      technicalOnly: true,
      kind: "vm",
      image: "images:ubuntu/24.04/cloud",
      desktop: {
        env: "ubuntu-xfce",
        user: "ubuntu",
        display: ":5",
        kasmPort: 6090,
        vncPort: 5905,
        webPort: 6090,
      },
    });
  });

  test("desktop-omarchy carries the omarchy bake on arch/cloud", () => {
    const plan = PLANS.find((p) => p.id === "desktop-omarchy");
    expect(plan).toMatchObject({
      cpu: 4,
      memoryMb: 4096,
      diskGb: 40,
      technicalOnly: true,
      kind: "vm",
      image: "images:archlinux/cloud",
      desktop: {
        env: "omarchy",
        user: "omarchy",
        display: ":5",
        kasmPort: 6090,
        vncPort: 5905,
        webPort: 6090,
      },
    });
  });

  test("existing plans stay desktop-free", () => {
    for (const plan of PLANS.filter((p) => !p.id.startsWith("desktop-"))) {
      expect(plan.desktop).toBeUndefined();
    }
  });
});

describe("tier quotas untouched", () => {
  test("quotas still match the frozen footprint", () => {
    expect(TIER_QUOTAS).toEqual({
      nontechnical: { servers: 1, cpu: 2, memoryMb: 2048, diskGb: 20 },
      technical: { servers: 3, cpu: 8, memoryMb: 8192, diskGb: 100 },
    });
  });
});
