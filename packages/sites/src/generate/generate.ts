import { z } from "zod/v4";
import { validateSpec, type SiteSpec } from "../schema";
import { findPlaceholders, renderSite, specFacts } from "../render";
import { hashLlmRequest } from "./hash";
import { LlmClientError } from "./openrouter";
import {
  Plan,
  pageFillSchema,
  planRequest,
  fillRequest,
  type PlannedPage,
} from "./prompts";
import {
  SiteBrief,
  type GenerateOptions,
  type GenerateResult,
  type LlmCallRecord,
  type LlmRequest,
  type LlmResponse,
} from "./types";

class CheckError extends Error {
  constructor(
    public readonly code: string,
    public readonly issues: string[],
  ) {
    super(issues.join("; "));
    this.name = "CheckError";
  }
}
function issueStrings(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "output"}: ${issue.message}`,
  );
}
function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new CheckError("invalid_json", [
      "Response must be valid JSON, without markdown fences or trailing text",
    ]);
  }
}
function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
function requestedPages(brief: SiteBrief): string[] | undefined {
  if (brief.pagesWanted === undefined) return undefined;
  const names = [...new Set(brief.pagesWanted.map(normalizedName))].filter(
    (name) => name !== "home",
  );
  if (names.includes(""))
    throw new CheckError("invalid_brief", [
      "pagesWanted must contain meaningful page names",
    ]);
  if (names.length > 7)
    throw new CheckError("invalid_brief", [
      "At most seven requested pages fit alongside the required home page",
    ]);
  return names;
}
function businessFromBrief(
  brief: SiteBrief,
  tagline?: string,
): SiteSpec["business"] {
  const a = brief.address;
  const address = a
    ? [
        a.street,
        a.city,
        [a.region, a.postalCode].filter(Boolean).join(" "),
        a.country,
      ]
        .filter(Boolean)
        .join(", ")
    : undefined;
  return {
    name: brief.businessName,
    niche: brief.niche,
    ...(tagline ? { tagline } : {}),
    ...(brief.phone !== undefined ? { phone: brief.phone } : {}),
    ...(brief.email !== undefined ? { email: brief.email } : {}),
    ...(address ? { address } : {}),
    serviceArea: structuredClone(brief.serviceArea ?? []),
    hours: structuredClone(brief.hours ?? []),
    socials: [],
  };
}
function checkSpec(candidate: unknown) {
  const validation = validateSpec(candidate);
  if (!validation.ok)
    throw new CheckError(
      "schema_error",
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
    );
  let rendered: ReturnType<typeof renderSite>;
  try {
    rendered = renderSite(validation.spec, { baseUrl: "https://localhost" });
  } catch (error) {
    throw new CheckError("render_error", [
      error instanceof Error ? error.message : "Rendering failed",
    ]);
  }
  const placeholders = findPlaceholders(rendered.files);
  if (placeholders.length)
    throw new CheckError(
      "placeholder",
      placeholders.map(
        (match) => `${match.file}: forbidden placeholder ${match.placeholder}`,
      ),
    );
  const visible = [...rendered.files]
    .filter(([path]) => path.endsWith(".html"))
    .map(([, html]) =>
      html
        .replace(/<head>.*?<\/head>/gs, "")
        .replace(/<[^>]*>/g, " ")
        .replace(
          /&(amp|lt|gt|quot|#39);/g,
          (_, entity: string) =>
            ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!,
        )
        .replace(/\s+/g, " "),
    )
    .join("\n");
  const missing = specFacts(validation.spec).filter(
    (fact) => !visible.includes(fact.replace(/\s+/g, " ")),
  );
  if (missing.length)
    throw new CheckError(
      "missing_fact",
      missing.map((fact) => `Required fact absent from rendered text: ${fact}`),
    );
  return { spec: validation.spec, warnings: rendered.warnings };
}
function checkedPlan(input: unknown, wanted: string[] | undefined): Plan {
  const result = Plan.safeParse(input);
  if (!result.success)
    throw new CheckError("schema_error", issueStrings(result.error));
  const plan = result.data,
    issues: string[] = [];
  if (plan.pages.filter((page) => page.slug === "").length !== 1)
    issues.push("pages: exactly one home page with empty slug is required");
  if (new Set(plan.pages.map((page) => page.slug)).size !== plan.pages.length)
    issues.push("pages: slugs must be unique");
  if (wanted !== undefined) {
    const other = plan.pages.filter((page) => page.slug !== "");
    if (other.length !== wanted.length)
      issues.push(
        `pages: include exactly home plus the ${wanted.length} requested pages`,
      );
    const remaining = new Set(wanted);
    for (const page of other) {
      const match = wanted.includes(page.slug)
        ? page.slug
        : normalizedName(page.title);
      if (!remaining.delete(match))
        issues.push(
          `pages: ${page.slug} does not uniquely match a requested page`,
        );
    }
    for (const name of remaining)
      issues.push(`pages: requested page ${name} is missing`);
  }
  for (const match of findPlaceholders(
    new Map([["plan", JSON.stringify(plan)]]),
  ))
    issues.push(`plan: forbidden placeholder ${match.placeholder}`);
  if (issues.length) throw new CheckError("invalid_plan", issues);
  return plan;
}

/** Plan once, fill with bounded parallelism, and escalate only failed work. */
export async function generateSite(
  brief: SiteBrief,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const calls: LlmCallRecord[] = [];
  let escalated = false,
    observerFailed = false;
  const fail = (error: unknown): GenerateResult => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    calls,
    escalated,
  });
  const checkAbort = () => {
    if (opts.signal?.aborted)
      throw new CheckError("aborted", ["Site generation aborted"]);
  };
  const publish = (call: LlmCallRecord) => {
    calls.push(call);
    try {
      opts.onCall?.(call);
    } catch {
      observerFailed = true;
    }
  };
  async function call<T>(
    request: LlmRequest,
    stage: LlmCallRecord["stage"],
    check: (input: unknown) => T,
  ): Promise<T> {
    checkAbort();
    if (observerFailed)
      throw new CheckError("observer_error", ["onCall callback failed"]);
    const started = performance.now();
    let response: LlmResponse | undefined, error: unknown;
    try {
      response = await opts.llm.complete(request);
      return check(parseJson(response.content));
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
      if (caught instanceof LlmClientError) response = caught.response;
      throw error;
    } finally {
      const usage = response?.usage;
      publish({
        stage,
        provider: response?.provider ?? "unknown",
        model: response?.model ?? request.model,
        providerRequestId: response?.providerRequestId ?? null,
        promptHash: hashLlmRequest(request),
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        costMicroUsd: usage?.costMicroUsd ?? 0n,
        latencyMs:
          response?.latencyMs ?? Math.round(performance.now() - started),
        status: error === undefined ? "ok" : "error",
        errorCode:
          error === undefined
            ? null
            : error instanceof CheckError || error instanceof LlmClientError
              ? error.code
              : "client_error",
      });
    }
  }
  const errorsForRetry = (error: unknown): string[] =>
    (error instanceof CheckError
      ? error.issues
      : [error instanceof Error ? error.message : "Model call failed"]
    )
      .slice(0, 15)
      .map((issue) => issue.slice(0, 500));
  try {
    const parsed = SiteBrief.safeParse(brief);
    if (!parsed.success)
      throw new CheckError("invalid_brief", issueStrings(parsed.error));
    brief = parsed.data;
    const wanted = requestedPages(brief),
      concurrency = opts.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new CheckError("invalid_options", [
        "concurrency must be a positive integer",
      ]);
    // Some fields in the shared brief contract are looser than SiteSpec. Report
    // impossible customer facts before billing instead of asking AI to change them.
    checkSpec({
      version: 1,
      business: businessFromBrief(brief),
      theme: { preset: "ocean", fonts: "modern" },
      pages: [
        {
          slug: "",
          title: brief.businessName,
          description: "Business information",
          sections: [
            {
              type: "hero.centered",
              heading: brief.businessName,
              text: "Contact us for information.",
            },
          ],
        },
      ],
    });
    let plan: Plan;
    try {
      plan = await call(
        planRequest(opts.models.plan, brief, wanted),
        "plan",
        (input) => checkedPlan(input, wanted),
      );
    } catch (error) {
      checkAbort();
      if (observerFailed)
        throw new CheckError("observer_error", ["onCall callback failed"]);
      escalated = true;
      plan = await call(
        planRequest(opts.models.escalate, brief, wanted, errorsForRetry(error)),
        "escalate",
        (input) => checkedPlan(input, wanted),
      );
    }
    checkAbort();
    if (observerFailed)
      throw new CheckError("observer_error", ["onCall callback failed"]);
    const business = businessFromBrief(brief, plan.tagline);
    // A tagline is plan-owned: reject its effect before starting page fills.
    checkSpec({
      version: 1,
      business,
      theme: plan.theme,
      pages: [
        {
          slug: "",
          title: brief.businessName,
          description: "Business information",
          sections: [
            {
              type: "hero.centered",
              heading: brief.businessName,
              text: "Contact us for information.",
            },
          ],
        },
      ],
    });
    type Page = SiteSpec["pages"][number];
    const pages: (Page | undefined)[] = Array(plan.pages.length);
    const failures: (unknown | undefined)[] = Array(plan.pages.length);
    let next = 0,
      pageFailed = false;
    function checkPage(input: unknown, page: PlannedPage): Page {
      const parsed = pageFillSchema(page).safeParse(input);
      if (!parsed.success)
        throw new CheckError("schema_error", issueStrings(parsed.error));
      const result = parsed.data;
      const mismatches = result.sections.flatMap((section, i) =>
        section.type === page.sectionTypes[i]
          ? []
          : [
              `sections.${i}.type: expected ${page.sectionTypes[i]}, received ${section.type}`,
            ],
      );
      if (mismatches.length) throw new CheckError("section_order", mismatches);
      const candidate = { slug: page.slug, ...result };
      checkSpec({
        version: 1,
        business,
        theme: plan.theme,
        pages: [{ ...candidate, slug: "" }],
      });
      return candidate;
    }
    async function worker() {
      while (
        next < plan.pages.length &&
        !pageFailed &&
        !observerFailed &&
        !opts.signal?.aborted
      ) {
        const index = next++,
          page = plan.pages[index]!;
        try {
          try {
            pages[index] = await call(
              fillRequest(opts.models.fill, brief, plan, page),
              "fill",
              (input) => checkPage(input, page),
            );
          } catch (error) {
            checkAbort();
            if (observerFailed)
              throw new CheckError("observer_error", [
                "onCall callback failed",
              ]);
            escalated = true;
            pages[index] = await call(
              fillRequest(
                opts.models.escalate,
                brief,
                plan,
                page,
                errorsForRetry(error),
              ),
              "escalate",
              (input) => checkPage(input, page),
            );
          }
        } catch (error) {
          failures[index] = error;
          pageFailed = true;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, plan.pages.length) }, worker),
    );
    checkAbort();
    if (observerFailed)
      throw new CheckError("observer_error", ["onCall callback failed"]);
    const failed = failures.find((error) => error !== undefined);
    if (failed !== undefined) throw failed;
    const checked = checkSpec({
      version: 1,
      business,
      theme: plan.theme,
      pages,
    });
    return {
      ok: true,
      spec: checked.spec,
      calls,
      escalated,
      warnings: checked.warnings,
    };
  } catch (error) {
    return fail(error);
  }
}
