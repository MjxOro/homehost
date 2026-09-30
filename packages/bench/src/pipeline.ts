/**
 * The ONLY module that touches the site generation pipeline. Everything else in
 * the bench imports these four names from "./pipeline".
 *
 * TEMPORARY: `generateSite`, `createOpenRouterClient` and `PROMPT_VERSION` are
 * stubs because the pipeline is not merged on this branch yet, and
 * `hashLlmRequest` is a local implementation of the documented contract.
 * When rebasing onto the finished pipeline, replace this whole file with:
 *
 *   export {
 *     PROMPT_VERSION,
 *     createOpenRouterClient,
 *     generateSite,
 *     hashLlmRequest,
 *   } from "@homehost/sites";
 */
import { createHash } from "node:crypto";
import type {
  GenerateOptions,
  GenerateResult,
  LlmClient,
  LlmRequest,
  SiteBrief,
} from "@homehost/sites";

/** STUB. Real value comes from the pipeline's prompt files. */
export const PROMPT_VERSION = "unmerged-stub";

/** JSON with object keys sorted at every depth; `undefined` members are dropped. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the canonical request JSON. Also the replay-cache key. */
export function hashLlmRequest(request: LlmRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** STUB. */
export async function generateSite(
  _brief: SiteBrief,
  _opts: GenerateOptions,
): Promise<GenerateResult> {
  throw new Error("generateSite not merged yet");
}

/** STUB. */
export function createOpenRouterClient(_opts: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}): LlmClient {
  throw new Error("createOpenRouterClient not merged yet");
}
