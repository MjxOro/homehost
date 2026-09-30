import { expect, test } from "bun:test";
import { hashLlmRequest, canonicalJson, sha256 } from "./hash";
import {
  PROMPT_VERSION,
  PROMPT_DEFINITION,
  PROMPT_TEMPLATES,
  SECTION_CATALOG,
  Plan,
  planRequest,
  fillRequest,
  pageFillSchema,
} from "./prompts";
import { Section } from "../schema";
import type { LlmRequest, SiteBrief } from "./types";

test("request hashes sort nested object keys while preserving arrays and JSON semantics", () => {
  const a: LlmRequest = {
    model: "small",
    messages: [{ role: "user", content: "Hello" }],
    jsonSchema: {
      name: "test",
      schema: {
        type: "object",
        properties: {
          a: { type: "string", maxLength: 10 },
          b: { type: "number" },
        },
      },
    },
  };
  const b: LlmRequest = {
    jsonSchema: {
      schema: {
        properties: {
          b: { type: "number" },
          a: { maxLength: 10, type: "string" },
        },
        type: "object",
      },
      name: "test",
    },
    messages: [{ content: "Hello", role: "user" }],
    model: "small",
    temperature: undefined,
  };
  expect(hashLlmRequest(a)).toBe(hashLlmRequest(b));
  expect(hashLlmRequest(a)).toMatch(/^[a-f0-9]{64}$/);
  expect(hashLlmRequest({ ...a, model: "different" })).not.toBe(
    hashLlmRequest(a),
  );
  expect(
    hashLlmRequest({ ...a, messages: [{ role: "user", content: "Changed" }] }),
  ).not.toBe(hashLlmRequest(a));
  expect(
    canonicalJson({
      __proto__: null,
      z: 1,
      a: [3, undefined, 1],
      missing: undefined,
    }),
  ).toBe('{"a":[3,null,1],"z":1}');
});
test("prompt version is deterministic and templates/schema changes affect hashes", async () => {
  expect(PROMPT_VERSION).toMatch(/^[a-f0-9]{12}$/);
  expect(PROMPT_VERSION).toBe(sha256(PROMPT_DEFINITION).slice(0, 12));
  expect((await import("./prompts")).PROMPT_VERSION).toBe(PROMPT_VERSION);
  expect(PROMPT_VERSION).not.toBe(
    sha256({
      ...PROMPT_DEFINITION,
      templates: { ...PROMPT_TEMPLATES, fill: "Changed instruction" },
    }).slice(0, 12),
  );
  const changedSchema = JSON.parse(JSON.stringify(PROMPT_DEFINITION));
  changedSchema.schemas.fill.properties.description.maxLength = 100;
  expect(PROMPT_VERSION).not.toBe(sha256(changedSchema).slice(0, 12));
});
test("catalog lists every plannable schema ID with nested field limits and omits ungrounded sections", () => {
  const ungrounded = ["testimonials.cards", "pricing.table", "team.cards"];
  for (const option of Section.options)
    if (ungrounded.includes(option.shape.type.value))
      expect(SECTION_CATALOG).not.toContain(option.shape.type.value);
    else expect(SECTION_CATALOG).toContain(`${option.shape.type.value}:`);
  expect(SECTION_CATALOG).toContain("heading:string <=160 chars");
  expect(SECTION_CATALOG).toContain("answer:string <=2000 chars");
  expect(SECTION_CATALOG).toContain("1..24 items");
});
test("brief goes last and system prefix is stable across businesses and retries", () => {
  const brief: SiteBrief = {
    businessName: "Birch Plumbing",
    niche: "Plumbing",
    description: "Residential repairs",
  };
  const a = planRequest("small", brief, undefined),
    b = planRequest(
      "larger",
      { ...brief, businessName: "Fir Plumbing" },
      undefined,
      ["pages: home missing"],
    );
  expect(a.messages[0]).toEqual(b.messages[0]);
  expect(a.messages[0]!.content).not.toContain(brief.businessName);
  expect(a.messages.at(-1)!.content.endsWith(canonicalJson(brief))).toBe(true);
  expect(b.messages.at(-1)!.content).toContain("pages: home missing");
  const plan = Plan.parse({
    tagline: "Repairs with care",
    theme: { preset: "ocean", fonts: "modern" },
    pages: [
      {
        slug: "",
        title: "Home",
        purpose: "Welcome",
        sectionTypes: ["hero.centered", "contact.details"],
      },
    ],
  });
  const request = fillRequest("small", brief, plan, plan.pages[0]!);
  expect(request.messages.at(-1)!.content.endsWith(canonicalJson(brief))).toBe(
    true,
  );
  const schema: any = request.jsonSchema!.schema;
  expect(
    schema.properties.sections.items.anyOf.map(
      (s: any) => s.properties.type.const,
    ),
  ).toEqual(["hero.centered", "contact.details"]);
  expect(schema.properties.sections.minItems).toBe(2);
  expect(schema.properties.sections.maxItems).toBe(2);
  expect(
    pageFillSchema(plan.pages[0]!).safeParse({
      title: "Home",
      description: "Repairs",
      sections: [
        { type: "about.text", heading: "About", text: "Hello" },
        { type: "contact.details", heading: "Call" },
      ],
    }).success,
  ).toBe(false);
});
