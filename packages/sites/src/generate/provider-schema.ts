import { canonicalJson } from "./hash";

/**
 * Providers enforce structure; Zod enforces the full contract after generation.
 * Length/count/format bounds explode some providers' constrained-decoder states.
 * Whitelist structural keywords rather than trying to enumerate every bound.
 * Property names and enum/const literals are data, not schema keyword nodes.
 */
export function providerSchema(schema: object): object {
  function relax(input: unknown): unknown {
    if (input === null || typeof input !== "object") return input;
    const node = input as Record<string, unknown>;
    if ("$ref" in node)
      throw new Error("Provider schema must be inline, not a $ref");
    const out: Record<string, unknown> = {};
    for (const key of [
      "type",
      "properties",
      "required",
      "additionalProperties",
      "enum",
      "const",
      "items",
      "anyOf",
    ] as const) {
      if (!(key in node)) continue;
      const value = node[key];
      if (key === "properties")
        out[key] = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(
            ([name, child]) => [name, relax(child)],
          ),
        );
      else if (key === "items") out[key] = relax(value);
      else if (key === "anyOf") out[key] = (value as unknown[]).map(relax);
      else out[key] = value;
    }
    return out;
  }
  // Stable bytes even if callers pass equivalent schemas with reordered keys.
  // Reuse the pipeline's canonical JSON semantics; do not mutate Zod's schema.
  return JSON.parse(canonicalJson(relax(schema))) as object;
}
