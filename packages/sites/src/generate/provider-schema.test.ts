import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { Section, SiteSpec } from "../schema";
import { providerSchema } from "./provider-schema";
import {
  Plan,
  planRequest,
  fillRequest,
  pageFillSchema,
  PROMPT_DEFINITION,
  PROMPT_VERSION,
} from "./prompts";
import { sha256 } from "./hash";

test("relaxation is deterministic, immutable and preserves structural keywords and literal data", () => {
  const strict = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        maxLength: 40,
        pattern: "^ok$",
        format: "email",
        description: "Annotation",
      },
      nested: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: { type: "number", minimum: 0, maximum: 100, multipleOf: 2 },
      },
      kind: { type: "string", const: "maxLength" },
    },
    required: ["pattern", "kind"],
  };
  const before = JSON.stringify(strict);
  expect(providerSchema(strict)).toEqual({
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      nested: { type: "array", items: { type: "number" } },
      kind: { type: "string", const: "maxLength" },
    },
    required: ["pattern", "kind"],
  });
  expect(JSON.stringify(strict)).toBe(before);
  expect(JSON.stringify(providerSchema(strict))).toBe(
    JSON.stringify(
      providerSchema({
        required: strict.required,
        properties: strict.properties,
        additionalProperties: false,
        type: "object",
      }),
    ),
  );
  expect(() => providerSchema({ $ref: "#/$defs/missing" })).toThrow("inline");
});

test("every section, including non-plannable ones, survives the structural schema projection", () => {
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "const",
    "items",
    "anyOf",
  ]);
  function check(node: any) {
    for (const key of Object.keys(node)) expect(allowed.has(key)).toBe(true);
    if (node.type === "object") expect(node.additionalProperties).toBe(false);
    for (const child of Object.values(node.properties ?? {})) check(child);
    if (node.items) check(node.items);
    for (const child of node.anyOf ?? []) check(child);
  }
  for (const section of Section.options) {
    const strict: any = z.toJSONSchema(section),
      relaxed: any = providerSchema(strict);
    expect(relaxed.properties.type.const).toBe(section.shape.type.value);
    expect(Object.keys(relaxed.properties)).toEqual(
      Object.keys(strict.properties).sort(),
    );
    expect(relaxed.required).toEqual(strict.required);
    check(relaxed);
  }
  check(providerSchema(z.toJSONSchema(SiteSpec)));
});

test("requests use relaxed provider schemas, prompts carry bounds, and strict Zod still rejects violations", () => {
  const brief = {
    businessName: "Birch Plumbing",
    niche: "Plumbing",
    description: "Residential repairs",
  };
  const plan = Plan.parse({
    theme: { preset: "ocean", fonts: "modern" },
    tagline: "Local repairs",
    pages: [
      {
        slug: "",
        title: "Home",
        purpose: "Welcome",
        sectionTypes: ["hero.centered", "contact.details"],
      },
    ],
  });
  const request = planRequest("small", brief, undefined);
  expect(request.jsonSchema?.schema).toEqual(
    providerSchema(z.toJSONSchema(Plan)),
  );
  expect(request.messages[0]?.content).toContain("Plan field limits:");
  expect(request.messages[0]?.content).toContain("1..8 items");
  expect(request.messages[0]?.content).toContain("purpose:string <=240 chars");
  const fill = fillRequest("small", brief, plan, plan.pages[0]!);
  expect(fill.messages[0]?.content).toContain("description:string <=320 chars");
  expect(fill.messages[0]?.content).toContain("title:string <=160 chars");
  expect(fill.messages[0]?.content).toContain("heading:string <=160 chars");
  expect(fill.messages[0]?.content).toContain("never markdown fences");
  expect(
    pageFillSchema(plan.pages[0]!).safeParse({
      title: "x".repeat(161),
      description: "Repairs",
      sections: [],
    }).success,
  ).toBe(false);
  expect(
    Plan.safeParse({ ...plan, pages: Array(9).fill(plan.pages[0]) }).success,
  ).toBe(false);
  expect(PROMPT_VERSION).toBe(sha256(PROMPT_DEFINITION).slice(0, 12));
  expect(PROMPT_VERSION).not.toBe(
    sha256({ ...PROMPT_DEFINITION, providerSchemas: {} }).slice(0, 12),
  );
});
