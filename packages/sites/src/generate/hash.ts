import { createHash } from "node:crypto";
import type { LlmRequest } from "./types";

/** JSON semantics (omit undefined object fields), with recursively sorted keys. */
export function canonicalJson(value: unknown): string {
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, sorted(item)]),
      );
    }
    return input;
  }
  const result = JSON.stringify(sorted(value));
  if (result === undefined) throw new Error("Expected a JSON value");
  return result;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashLlmRequest(request: LlmRequest): string {
  return sha256(request);
}
