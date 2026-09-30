import { z } from "zod/v4";
import { DAYS, type SiteSpec } from "../schema";

/**
 * Contract between the site generation pipeline (`generateSite`) and its
 * callers (the API later, `@homehost/bench` now). Facts the customer typed
 * (name, phone, email, address, hours) are copied into the spec by code;
 * the model only chooses structure and writes copy.
 */
export const SiteBrief = z.strictObject({
  businessName: z.string().min(1).max(120),
  niche: z.string().min(1).max(80),
  /** Free text from the customer: what they do, who for, what makes them different. */
  description: z.string().min(1).max(2000),
  city: z.string().max(80).optional(),
  phone: z.string().max(40).optional(),
  email: z.email().max(254).optional(),
  address: z
    .strictObject({
      street: z.string().max(120),
      city: z.string().max(80),
      region: z.string().max(80),
      postalCode: z.string().max(20),
      country: z.string().max(80),
    })
    .optional(),
  serviceArea: z.array(z.string().max(80)).max(20).optional(),
  hours: z
    .array(
      z.strictObject({
        days: z.array(z.enum(DAYS)).min(1).max(7),
        opens: z.string().regex(/^\d{2}:\d{2}$/),
        closes: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    )
    .max(14)
    .optional(),
  /** Page names the customer asked for, e.g. ["Services", "About"]. */
  pagesWanted: z.array(z.string().max(40)).max(8).optional(),
  tone: z.string().max(80).optional(),
});
export type SiteBrief = z.infer<typeof SiteBrief>;

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmRequest = {
  model: string;
  /** Stable prefix first (instructions, catalog, schema), variable parts last, so provider prompt caching hits. */
  messages: LlmMessage[];
  /** Provider-enforced structured output. */
  jsonSchema?: { name: string; schema: object };
  temperature?: number;
  maxOutputTokens?: number;
};

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Integer micro-dollars as billed by the provider. Never a float. */
  costMicroUsd: bigint;
};

export type LlmResponse = {
  /** Raw text content; JSON text when `jsonSchema` was set. */
  content: string;
  provider: string;
  /** Model that actually served the call (may differ from the requested alias). */
  model: string;
  providerRequestId: string | null;
  usage: LlmUsage;
  latencyMs: number;
};

/** Anything that can answer an LlmRequest: OpenRouter, a replay cache, a test double. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** One finished model call, shaped to map 1:1 onto the API's `recordLlmCall` input. */
export type LlmCallRecord = {
  stage: "plan" | "fill" | "escalate";
  provider: string;
  model: string;
  providerRequestId: string | null;
  /** sha256 hex of the canonical request JSON. */
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: bigint;
  latencyMs: number;
  status: "ok" | "error";
  errorCode: string | null;
};

export type GenerateModels = {
  /** Mid model: picks pages, section types, theme. */
  plan: string;
  /** Cheap model: writes copy for each page in parallel. */
  fill: string;
  /** Used only to redo a part that failed deterministic checks. */
  escalate: string;
};

export type GenerateOptions = {
  llm: LlmClient;
  models: GenerateModels;
  /** Max parallel fill calls. Default 4. */
  concurrency?: number;
  /**
   * Called after every model call, success or failure, and awaited before the
   * call's result is used. A throw or rejection fails generation.
   */
  onCall?: (call: LlmCallRecord) => void | Promise<void>;
  signal?: AbortSignal;
};

export type GenerateResult =
  | {
      ok: true;
      spec: SiteSpec;
      calls: LlmCallRecord[];
      escalated: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      calls: LlmCallRecord[];
      escalated: boolean;
    };
