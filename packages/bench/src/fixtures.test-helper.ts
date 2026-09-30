import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LlmRequest, LlmResponse, SiteSpec } from "@homehost/sites";
import type { Task, Candidate } from "./tasks";

// Temp artifacts stay inside this worktree and its ignored run directory.
export async function temporary() {
  const root = new URL("../../../bench-runs/", import.meta.url).pathname;
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export const example = (await Bun.file(
  new URL("../../sites/examples/plumber.json", import.meta.url),
).json()) as SiteSpec;
export const task: Task = {
  id: "fixture-plumber",
  suite: "site-build",
  tags: ["plumbing"],
  brief: {
    businessName: example.business.name,
    niche: example.business.niche,
    description: "Local residential repairs with written estimates.",
    city: "Victoria",
    phone: example.business.phone,
    email: example.business.email,
    address: {
      street: "184 Alder Street",
      city: "Victoria",
      region: "BC",
      postalCode: "V8V 2A1",
      country: "Canada",
    },
    serviceArea: example.business.serviceArea,
    hours: example.business.hours,
  },
  expect: { minPages: 3, maxPages: 3 },
};
export const candidate: Candidate = {
  id: "fixture",
  models: { plan: "test/plan", fill: "test/fill", escalate: "test/escalate" },
};
export const request: LlmRequest = {
  model: "test/plan",
  messages: [{ role: "user", content: "Return a site" }],
  temperature: 0.2,
  maxOutputTokens: 100,
};
export function response(cost = 1000n): LlmResponse {
  return {
    content: JSON.stringify({ valid: true }),
    provider: "scripted",
    model: request.model,
    providerRequestId: crypto.randomUUID(),
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheWriteTokens: 0,
      costMicroUsd: cost,
    },
    latencyMs: 42,
  };
}
