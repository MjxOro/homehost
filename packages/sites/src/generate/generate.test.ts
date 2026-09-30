import { expect, test } from "bun:test";
import { generateSite } from "./generate";
import { hashLlmRequest } from "./hash";
import { createOpenRouterClient, LlmClientError } from "./openrouter";
import type { Plan } from "./prompts";
import type {
  GenerateOptions,
  LlmClient,
  LlmCallRecord,
  LlmRequest,
  LlmResponse,
  SiteBrief,
} from "./types";
import { renderSite } from "../render";

function brief(): SiteBrief {
  return {
    businessName: "Birch & Brook Plumbing",
    niche: "Residential plumbing",
    description:
      "We repair leaking taps, clear household drains and install water heaters. Written estimates before work begins.",
    phone: "+1 (250) 555-0147",
    email: "hello@birchbrook.ca",
    address: {
      street: "184 Alder Street",
      city: "Victoria",
      region: "BC",
      postalCode: "V8V 2A1",
      country: "Canada",
    },
    serviceArea: ["Victoria", "Oak Bay"],
    hours: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        opens: "08:00",
        closes: "17:00",
      },
    ],
  };
}
function plan(slugs = [""]): Plan {
  return {
    tagline: "Thoughtful repairs for your home",
    theme: { preset: "ocean", fonts: "modern" },
    pages: slugs.map((slug) => ({
      slug,
      title: slug ? `${slug[0]!.toUpperCase()}${slug.slice(1)}` : "Home",
      purpose: "Explain our plumbing service",
      sectionTypes: ["hero.centered"],
    })),
  };
}
function fill(heading = "Repairs made clear") {
  return {
    title: "Plumbing services",
    description: "Residential plumbing with clear estimates.",
    sections: [
      {
        type: "hero.centered",
        heading,
        text: "Tell us about your leak, drain or water heater. We explain your options before starting work.",
      },
    ],
  };
}
function response(content: string, id: number): LlmResponse {
  return {
    content,
    provider: "scripted",
    model: "served-cheap",
    providerRequestId: `call-${id}`,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      cacheWriteTokens: 0,
      costMicroUsd: 10n,
    },
    latencyMs: 3,
  };
}
type Step = object | string | ((request: LlmRequest) => Promise<object>);
class ScriptedClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly steps: Step[]) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const id = this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (step === undefined) throw new Error("No scripted response available");
    if (step instanceof Error) throw step;
    const result = typeof step === "function" ? await step(request) : step;
    return response(
      typeof result === "string" ? result : JSON.stringify(result),
      id,
    );
  }
}
function options(
  llm: LlmClient,
  overrides: Partial<GenerateOptions> = {},
): GenerateOptions {
  return {
    llm,
    models: { plan: "planner", fill: "writer", escalate: "repairer" },
    ...overrides,
  };
}

test("customer facts are copied in code even if fill returns conflicting business fields", async () => {
  const input = brief(),
    before = structuredClone(input);
  const llm = new ScriptedClient([
    plan(),
    {
      ...fill(),
      phone: "+1 (604) 555-0100",
      business: {
        name: "Wrong name",
        phone: "+1 (604) 555-0100",
        email: "wrong@different.ca",
      },
    },
  ]);
  const result = await generateSite(input, options(llm));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.spec.business).toMatchObject({
    name: input.businessName,
    niche: input.niche,
    phone: input.phone,
    email: input.email,
    address: "184 Alder Street, Victoria, BC V8V 2A1, Canada",
    hours: input.hours,
    serviceArea: input.serviceArea,
    socials: [],
  });
  expect(input).toEqual(before);
  result.spec.business.hours[0]!.days.pop();
  expect(input).toEqual(before);
  expect(result.calls).toHaveLength(2);
  expect(result.escalated).toBe(false);
  expect(
    result.calls.every(
      (call, i) => call.promptHash === hashLlmRequest(llm.requests[i]!),
    ),
  ).toBe(true);
  expect(result.calls.every((call) => call.model === "served-cheap")).toBe(
    true,
  );
});
test("invalid brief makes zero model calls", async () => {
  const llm = new ScriptedClient([]);
  const result = await generateSite(
    { ...brief(), businessName: "" },
    options(llm),
  );
  expect(result).toMatchObject({ ok: false, calls: [], escalated: false });
  expect(llm.requests).toHaveLength(0);
});
const incompatibleFacts: Partial<SiteBrief>[] = [
  { phone: "not-a-phone" },
  { hours: [{ days: ["mon" as const], opens: "99:99", closes: "17:00" }] },
  { serviceArea: [""] },
];
test.each(incompatibleFacts)(
  "customer facts incompatible with SiteSpec fail before billing %j",
  async (fields) => {
    const llm = new ScriptedClient([]);
    const result = await generateSite({ ...brief(), ...fields }, options(llm));
    expect(result.ok).toBe(false);
    expect(result.calls).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  },
);
test("unknown section ID escalates the plan once then succeeds", async () => {
  const bad = plan();
  (bad.pages[0]!.sectionTypes as string[])[0] = "unknown.section";
  const llm = new ScriptedClient([bad, plan(), fill()]);
  const result = await generateSite(brief(), options(llm));
  expect(result.ok).toBe(true);
  expect(result.escalated).toBe(true);
  expect(llm.requests.map((request) => request.model)).toEqual([
    "planner",
    "repairer",
    "writer",
  ]);
  expect(result.calls.map((call) => [call.stage, call.status])).toEqual([
    ["plan", "error"],
    ["escalate", "ok"],
    ["fill", "ok"],
  ]);
  expect(llm.requests[1]!.messages.at(-1)!.content).toContain(
    "pages.0.sectionTypes.0",
  );
});
test.each(["testimonials.cards", "pricing.table", "team.cards"])(
  "a plan choosing %s, which needs facts the brief cannot supply, is escalated",
  async (type) => {
    const bad = plan();
    (bad.pages[0]!.sectionTypes as string[]).push(type);
    const llm = new ScriptedClient([bad, plan(), fill()]);
    const result = await generateSite(brief(), options(llm));
    expect(result.ok).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.calls.map((call) => [call.stage, call.errorCode])).toEqual([
      ["plan", "schema_error"],
      ["escalate", null],
      ["fill", null],
    ]);
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain(
      "pages.0.sectionTypes.1",
    );
    for (const request of llm.requests)
      expect(JSON.stringify(request)).not.toContain(type);
  },
);
test.each([
  "duplicate slug",
  "missing home",
  "bad slug",
  "placeholder tagline",
])("bad plan %s is repaired before fills start", async (kind) => {
  const bad = plan();
  if (kind === "duplicate slug") bad.pages.push(structuredClone(bad.pages[0]!));
  if (kind === "missing home") bad.pages[0]!.slug = "services";
  if (kind === "bad slug") bad.pages[0]!.slug = "../escape";
  if (kind === "placeholder tagline") bad.tagline = "Lorem ipsum";
  const result = await generateSite(
    brief(),
    options(new ScriptedClient([bad, plan(), fill()])),
  );
  expect(result.ok).toBe(true);
  expect(result.escalated).toBe(true);
  expect(result.calls).toHaveLength(3);
});
test("pagesWanted includes exactly home plus requested pages, with a repair for omissions", async () => {
  const input = { ...brief(), pagesWanted: ["Home", "Services"] };
  const llm = new ScriptedClient([
    plan(),
    plan(["", "services"]),
    fill("Welcome"),
    fill("Services"),
  ]);
  const result = await generateSite(input, options(llm));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.spec.pages.map((page) => page.slug)).toEqual(["", "services"]);
  expect(llm.requests[1]!.messages.at(-1)!.content).toContain(
    "requested page services is missing",
  );
});
test("pagesWanted cannot be satisfied by adding duplicate matches and extra pages", async () => {
  const bad = plan(["", "services", "extra"]);
  bad.pages[2]!.title = "Services";
  const llm = new ScriptedClient([bad, bad]);
  const result = await generateSite(
    { ...brief(), pagesWanted: ["Services"] },
    options(llm),
  );
  expect(result.ok).toBe(false);
  expect(result.calls).toHaveLength(2);
});
test("a placeholder escalates only the failed page and retains the other fill", async () => {
  const llm = new ScriptedClient([
    plan(["", "services"]),
    fill("TODO: your heading"),
    fill("Services we offer"),
    fill("Your local plumbing team"),
  ]);
  const result = await generateSite(
    { ...brief(), pagesWanted: ["Services"] },
    options(llm, { concurrency: 2 }),
  );
  expect(result.ok).toBe(true);
  expect(result.escalated).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(llm.requests.map((request) => request.model)).toEqual([
    "planner",
    "writer",
    "writer",
    "repairer",
  ]);
  expect(llm.requests[3]!.messages.at(-1)!.content).toContain(
    "forbidden placeholder todo",
  );
  expect(result.spec.pages[1]!.sections[0]!.heading).toBe("Services we offer");
  expect(result.spec.pages[0]!.sections[0]!.heading).toBe(
    "Your local plumbing team",
  );
  expect(
    result.calls.filter(
      (call) => call.stage === "fill" && call.status === "error",
    )[0]!.errorCode,
  ).toBe("placeholder");
});
test("one page cannot satisfy two requested names while another is unrelated", async () => {
  const bad = plan(["", "services", "unrelated"]);
  bad.pages[1]!.title = "About";
  const llm = new ScriptedClient([
    bad,
    plan(["", "services", "about"]),
    fill("Home"),
    fill("Services"),
    fill("About"),
  ]);
  const result = await generateSite(
    { ...brief(), pagesWanted: ["Services", "About"] },
    options(llm),
  );
  expect(result.ok).toBe(true);
  expect(result.calls[0]!.errorCode).toBe("invalid_plan");
  expect(llm.requests[1]!.messages.at(-1)!.content).toContain(
    "does not uniquely match a requested page",
  );
});
test("permanently failed fill stops scheduling unstarted pages", async () => {
  const llm = new ScriptedClient([
    plan(["", "services", "about"]),
    fill("Lorem"),
    fill("Ipsum"),
  ]);
  const result = await generateSite(brief(), options(llm, { concurrency: 1 }));
  expect(result.ok).toBe(false);
  expect(llm.requests.map((request) => request.model)).toEqual([
    "planner",
    "writer",
    "repairer",
  ]);
  expect(result.calls).toHaveLength(3);
});
test.each([
  { value: "```json\n{}\n```", code: "invalid_json" },
  { value: fill("x".repeat(161)), code: "schema_error" },
  {
    value: {
      ...fill(),
      sections: [{ type: "about.text", heading: "About", text: "Repairs" }],
    },
    code: "schema_error",
  },
])(
  "invalid page output is repaired with concrete issues %j",
  async ({ value, code }) => {
    const llm = new ScriptedClient([plan(), value, fill()]);
    const result = await generateSite(brief(), options(llm));
    expect(result.ok).toBe(true);
    expect(result.calls[1]!.errorCode).toBe(code);
    expect(llm.requests[2]!.messages.at(-1)!.content).toContain(
      "Previous attempt failed",
    );
  },
);
test("page section order is enforced even when all types are allowed", async () => {
  const structure = plan();
  structure.pages[0]!.sectionTypes = ["hero.centered", "contact.details"];
  const hero = fill().sections[0]!,
    contact = { type: "contact.details", heading: "Contact" };
  const llm = new ScriptedClient([
    structure,
    { ...fill(), sections: [contact, hero] },
    { ...fill(), sections: [hero, contact] },
  ]);
  const result = await generateSite(brief(), options(llm));
  expect(result.ok).toBe(true);
  expect(result.calls[1]!.errorCode).toBe("section_order");
  expect(llm.requests[2]!.messages.at(-1)!.content).toContain(
    "sections.0.type: expected hero.centered",
  );
});
test("still-failing fill returns false with all calls and billed error usage", async () => {
  const llm = new ScriptedClient([plan(), fill("Lorem"), fill("Ipsum")]);
  const seen: LlmCallRecord[] = [];
  const result = await generateSite(
    brief(),
    options(llm, { onCall: (call) => void seen.push(call) }),
  );
  expect(result.ok).toBe(false);
  expect(result.escalated).toBe(true);
  expect(result.calls).toHaveLength(3);
  expect(seen).toEqual(result.calls);
  expect(result.calls.map((call) => call.status)).toEqual([
    "ok",
    "error",
    "error",
  ]);
  expect(result.calls.reduce((sum, call) => sum + call.costMicroUsd, 0n)).toBe(
    30n,
  );
});
test("onCall sees transport failures as well as successful escalation", async () => {
  const seen: LlmCallRecord[] = [];
  const llm = new ScriptedClient([
    new Error("Connection reset"),
    plan(),
    fill(),
  ]);
  const result = await generateSite(
    brief(),
    options(llm, { onCall: (call) => void seen.push(call) }),
  );
  expect(result.ok).toBe(true);
  expect(seen).toEqual(result.calls);
  expect(seen[0]).toMatchObject({
    stage: "plan",
    status: "error",
    errorCode: "client_error",
    costMicroUsd: 0n,
    providerRequestId: null,
  });
  expect(seen[0]!.promptHash).toBe(hashLlmRequest(llm.requests[0]!));
});
test("provider errors carrying known usage preserve it in failed call records", async () => {
  const billed = response("", 99);
  const llm = new ScriptedClient([
    new LlmClientError("No content", "empty_response", billed),
    plan(),
    fill(),
  ]);
  const result = await generateSite(brief(), options(llm));
  expect(result.ok).toBe(true);
  expect(result.calls[0]).toMatchObject({
    status: "error",
    errorCode: "empty_response",
    providerRequestId: "call-99",
    costMicroUsd: 10n,
    inputTokens: 100,
  });
});
test("an OpenRouter response without cost is recorded as a missing_usage error", async () => {
  const llm = createOpenRouterClient({
    apiKey: "test-key",
    fetch: (async () =>
      Response.json({
        id: "gen-free",
        choices: [{ message: { content: JSON.stringify(plan()) } }],
        usage: { prompt_tokens: 80, completion_tokens: 30 },
      })) as unknown as typeof globalThis.fetch,
  });
  const seen: LlmCallRecord[] = [];
  const result = await generateSite(
    brief(),
    options(llm, { onCall: (call) => void seen.push(call) }),
  );
  expect(result.ok).toBe(false);
  expect(seen[0]).toMatchObject({
    stage: "plan",
    status: "error",
    errorCode: "missing_usage",
    providerRequestId: "gen-free",
    inputTokens: 80,
    outputTokens: 30,
    costMicroUsd: 0n,
  });
});
test("plan failure after escalation returns false without any fill calls", async () => {
  const llm = new ScriptedClient(["not JSON", "still not JSON"]);
  const result = await generateSite(brief(), options(llm));
  expect(result.ok).toBe(false);
  expect(result.calls).toHaveLength(2);
  expect(result.calls.every((call) => call.status === "error")).toBe(true);
});
test("bounded fill concurrency keeps output pages in plan order", async () => {
  const slugs = ["", "services", "about", "contact"];
  let active = 0,
    maximum = 0;
  const steps = slugs.map((slug, i) => async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 25 : 2));
    active--;
    return fill(slug || "Home");
  });
  const llm = new ScriptedClient([plan(slugs), ...steps]);
  const result = await generateSite(brief(), options(llm, { concurrency: 2 }));
  expect(result.ok).toBe(true);
  expect(maximum).toBe(2);
  if (!result.ok) throw new Error(result.error);
  expect(result.spec.pages.map((page) => page.slug)).toEqual(slugs);
  expect(result.spec.pages.map((page) => page.sections[0]!.heading)).toEqual([
    "Home",
    "services",
    "about",
    "contact",
  ]);
  expect(result.calls).toHaveLength(5);
});
test("all in-flight page calls are recorded even when one page cannot be repaired", async () => {
  const llm = new ScriptedClient([
    plan(["", "services"]),
    fill("Lorem"),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return fill("Services");
    },
    fill("Ipsum"),
  ]);
  const seen: LlmCallRecord[] = [];
  const result = await generateSite(
    brief(),
    options(llm, { onCall: (call) => void seen.push(call), concurrency: 2 }),
  );
  expect(result.ok).toBe(false);
  expect(result.calls).toHaveLength(4);
  expect(seen).toEqual(result.calls);
  expect(result.calls.filter((call) => call.status === "ok")).toHaveLength(2);
});
test("pre-aborted generation makes no model calls", async () => {
  const controller = new AbortController();
  controller.abort();
  const llm = new ScriptedClient([]);
  const result = await generateSite(
    brief(),
    options(llm, { signal: controller.signal }),
  );
  expect(result.ok).toBe(false);
  expect(result.escalated).toBe(false);
  expect(llm.requests).toHaveLength(0);
});
test("abort during fill stops subsequent pages and escalation without dropping billed calls", async () => {
  const controller = new AbortController();
  const llm = new ScriptedClient([
    plan(["", "services"]),
    async () => {
      controller.abort();
      return fill();
    },
  ]);
  const result = await generateSite(
    brief(),
    options(llm, { signal: controller.signal, concurrency: 1 }),
  );
  expect(result.ok).toBe(false);
  expect(result.calls).toHaveLength(2);
  expect(llm.requests).toHaveLength(2);
  expect(result.escalated).toBe(false);
});
test.each([
  {
    kind: "sync throw",
    onCall: () => {
      throw new Error("Ledger unavailable");
    },
  },
  {
    kind: "async rejection",
    onCall: async () => {
      await Promise.resolve();
      throw new Error("Ledger unavailable");
    },
  },
])(
  "an onCall $kind fails generation without billing a cascade",
  async ({ onCall }) => {
    const llm = new ScriptedClient([plan()]);
    const result = await generateSite(brief(), options(llm, { onCall }));
    expect(result).toMatchObject({
      ok: false,
      error: "onCall callback failed",
      escalated: false,
    });
    expect(result.calls).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  },
);
test("optional customer facts remain absent and escaped factual text passes checks", async () => {
  const input: SiteBrief = {
    businessName: 'Birch <Brook> & "Co"',
    niche: "Plumbing",
    description: "Tap repairs",
  };
  const result = await generateSite(
    input,
    options(new ScriptedClient([plan(), fill()])),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.spec.business.phone).toBeUndefined();
  expect(result.spec.business.hours).toEqual([]);
  expect(result.spec.business.serviceArea).toEqual([]);
  expect(
    renderSite(result.spec, { baseUrl: "https://localhost" }).files.get(
      "index.html",
    ),
  ).toContain("Birch &lt;Brook&gt; &amp; &quot;Co&quot;");
});
test("invalid concurrency returns an error before calls", async () => {
  const llm = new ScriptedClient([]);
  const result = await generateSite(brief(), options(llm, { concurrency: 0 }));
  expect(result.ok).toBe(false);
  expect(result.calls).toEqual([]);
});
