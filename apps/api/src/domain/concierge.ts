import { createHash } from "node:crypto";
import { and, count, eq, gte } from "drizzle-orm";
import { Context, Data, Duration, Effect, Either } from "effect";
import { z } from "zod/v4";
import {
  PLANS,
  PLAN_NONE,
  RECIPES,
  RECIPE_IDS,
  USE_CASES,
  USE_CASE_IDS,
  decideSuggestion,
} from "@homehost/shared";
import type { PortalUser, Suggestion } from "@homehost/shared";
import * as schema from "../db/schema.js";
import { DatabaseTag } from "./Database.js";
import { DbFailure } from "./errors.js";
import { finishAgentRun, recordLlmCall, startAgentRun } from "./ledger.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const JEV_MODEL = "typesafe/jev-1.13";
export const TRANSLATE_MODEL = "deepseek/deepseek-v4.1-flash";
/** Per provider call, including reading the body. */
export const CONCIERGE_TIMEOUT_MS = 10_000;
/** Translate only when Jev thinks the text is not English (is_english below this)... */
export const ENGLISH_MIN = 0.5;
/** ...and the use case came back unsure (confidence below this). */
export const TRANSLATE_USE_CASE_MIN = 0.7;
const PRICE_TABLE_VERSION = "openrouter-usage-cost";
const TRANSLATE_SYSTEM =
  "Translate the user's text into plain English. Keep product names, numbers and technical terms. Output only the translation.";

export interface ConciergeConfig {
  apiKey: string;
  /** Suggestions per user per UTC day (agent_runs of kind concierge). */
  dailyCap: number;
  /** Provider transport; tests inject a fake. */
  fetch: typeof globalThis.fetch;
  /** Clock for the daily window and call latency. */
  now: () => Date;
  timeoutMs?: number;
  baseUrl?: string;
}

export class ConciergeConfigTag extends Context.Tag("Homehost/Concierge")<
  ConciergeConfigTag,
  ConciergeConfig
>() {}

export class ConciergeCapReached extends Data.TaggedError(
  "ConciergeCapReached",
)<{ readonly cap: number }> {}

/** `code` is ours (http_502, timeout, network, bad_response); never a provider body. */
export class ConciergeUpstream extends Data.TaggedError("ConciergeUpstream")<{
  readonly code: string;
}> {}

export type ConciergeError = ConciergeCapReached | ConciergeUpstream;

const PLAN_OPTIONS: [string, ...string[]] = [
  PLAN_NONE,
  ...PLANS.map((p) => p.id),
];

const PLANS_TEXT = PLANS.map(
  (p) =>
    `${p.id}: ${p.cpu} cpu, ${p.memoryMb / 1024} GB RAM, ${p.diskGb} GB disk, ${p.kind}, ${p.desktop ? "graphical desktop" : "no desktop"}`,
).join("\n");

/** One Jev request, every question answered independently. */
const JEV_QUESTIONS = {
  use_case: {
    type: "choice",
    instructions:
      "What does the person mainly want a server from this homelab for? Pick the closest option.",
    criteria: Object.fromEntries(
      USE_CASE_IDS.map((id) => [id, USE_CASES[id].description]),
    ),
  },
  plan: {
    type: "choice",
    instructions: {
      plans: PLANS_TEXT,
      question:
        "Which `plans` entry is the smallest one that comfortably fits `request`?",
    },
    criteria: Object.fromEntries(PLAN_OPTIONS.map((id) => [id, null])),
  },
  recipe: {
    type: "choice",
    instructions:
      "Which setup should be installed on the new server right after it boots?",
    criteria: Object.fromEntries(
      RECIPE_IDS.map((id) => [id, RECIPES[id].description]),
    ),
  },
  wants_gui: {
    type: "noul",
    instructions:
      "Does the person want a graphical desktop (not just a terminal)?",
  },
  players_connect: {
    type: "noul",
    instructions:
      "Will other people (friends, players, customers) need to connect directly to this server?",
  },
  abuse: {
    type: "noul",
    instructions:
      "Does the request involve something against a hosting acceptable-use policy: crypto mining, port scanning, sending bulk email or spam, open proxies, torrenting, or attacking other systems?",
  },
  is_english: {
    type: "noul",
    instructions: "Is `request` written in English?",
  },
} as const;

const probability = z.number().min(0).max(1);
const tokens = z.number().int().nonnegative();
const choiceAnswer = <const T extends readonly [string, ...string[]]>(ids: T) =>
  z.object({
    choice: z.enum(ids),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  });
const noulAnswer = z.object({ noul: probability });

const JevResponse = z.object({
  id: z.string().optional(),
  model: z.string().min(1),
  answers: z.object({
    use_case: choiceAnswer(USE_CASE_IDS),
    plan: choiceAnswer(PLAN_OPTIONS),
    recipe: choiceAnswer(RECIPE_IDS),
    wants_gui: noulAnswer,
    players_connect: noulAnswer,
    abuse: noulAnswer,
    is_english: noulAnswer,
  }),
  usage: z.object({
    input_tokens: tokens,
    output_tokens: tokens,
    cost: z.number().nonnegative(),
  }),
});
type JevAnswers = z.infer<typeof JevResponse>["answers"];

const ChatResponse = z.object({
  id: z.string().optional(),
  model: z.string().min(1),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().min(1) }) }))
    .min(1),
  usage: z.object({
    prompt_tokens: tokens,
    completion_tokens: tokens,
    cost: z.number().nonnegative(),
    prompt_tokens_details: z
      .object({
        cached_tokens: tokens.optional(),
        cache_write_tokens: tokens.optional(),
      })
      .nullish(),
  }),
});

interface Billed<A> {
  value: A;
  model: string;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported USD. */
  cost: number;
}

/** USD float to integer micro-dollars, rounding up; the 1e-12 snap drops float noise. */
export function usdToMicroUsd(usd: number): bigint {
  return BigInt(Math.ceil(Math.round(usd * 1e12) / 1e6));
}

interface CallContext {
  config: ConciergeConfig;
  agentRunId: string;
  userId: string;
}

/**
 * POST one OpenRouter request and ledger it (ok or error). Failures surface as
 * ConciergeUpstream with our own code; the provider body is never kept.
 */
const callOpenRouter = <A>(
  ctx: CallContext,
  call: {
    path: string;
    model: string;
    body: Record<string, unknown>;
    parse: (json: unknown) => Billed<A> | null;
  },
) =>
  Effect.gen(function* () {
    const { config } = ctx;
    const payload = JSON.stringify(call.body);
    const promptHash = createHash("sha256").update(payload).digest("hex");
    const started = config.now().getTime();
    const outcome = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await config.fetch(
          `${config.baseUrl ?? OPENROUTER_BASE_URL}${call.path}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: payload,
            signal,
          },
        );
        return { status: response.status, text: await response.text() };
      },
      catch: () => "network",
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(config.timeoutMs ?? CONCIERGE_TIMEOUT_MS),
        onTimeout: () => "timeout",
      }),
      Effect.flatMap(({ status, text }) => {
        if (status < 200 || status >= 300) return Effect.fail(`http_${status}`);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return Effect.fail("bad_response");
        }
        const billed = call.parse(json);
        return billed ? Effect.succeed(billed) : Effect.fail("bad_response");
      }),
      Effect.either,
    );
    const latencyMs = Math.max(0, config.now().getTime() - started);
    const row = {
      agentRunId: ctx.agentRunId,
      userId: ctx.userId,
      purpose: "prod",
      provider: "openrouter",
      promptHash,
      priceTableVersion: PRICE_TABLE_VERSION,
      latencyMs,
    } as const;
    if (Either.isLeft(outcome)) {
      yield* recordLlmCall({
        ...row,
        model: call.model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 0n,
        status: "error",
        errorCode: outcome.left,
      });
      return yield* new ConciergeUpstream({ code: outcome.left });
    }
    const billed = outcome.right;
    yield* recordLlmCall({
      ...row,
      model: billed.model,
      providerRequestId: billed.requestId,
      inputTokens: billed.inputTokens,
      outputTokens: billed.outputTokens,
      cachedInputTokens: billed.cachedInputTokens,
      cacheWriteTokens: billed.cacheWriteTokens,
      costMicroUsd: usdToMicroUsd(billed.cost),
      status: "ok",
    });
    return billed.value;
  });

const askJev = (ctx: CallContext, text: string) =>
  callOpenRouter(ctx, {
    path: "/alpha/decisions",
    model: JEV_MODEL,
    body: {
      model: JEV_MODEL,
      state: { request: text },
      questions: JEV_QUESTIONS,
    },
    parse: (json): Billed<{ model: string; answers: JevAnswers }> | null => {
      const r = JevResponse.safeParse(json);
      if (!r.success) return null;
      return {
        value: { model: r.data.model, answers: r.data.answers },
        model: r.data.model,
        requestId: r.data.id ?? null,
        inputTokens: r.data.usage.input_tokens,
        outputTokens: r.data.usage.output_tokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        cost: r.data.usage.cost,
      };
    },
  });

const translate = (ctx: CallContext, text: string) =>
  callOpenRouter(ctx, {
    path: "/v1/chat/completions",
    model: TRANSLATE_MODEL,
    body: {
      model: TRANSLATE_MODEL,
      temperature: 0,
      max_tokens: 300,
      reasoning: { effort: "minimal", exclude: true },
      usage: { include: true },
      messages: [
        { role: "system", content: TRANSLATE_SYSTEM },
        { role: "user", content: text },
      ],
    },
    parse: (json): Billed<string> | null => {
      const r = ChatResponse.safeParse(json);
      const english = r.success
        ? r.data.choices[0]!.message.content.trim()
        : "";
      if (!r.success || english.length === 0) return null;
      return {
        value: english,
        model: r.data.model,
        requestId: r.data.id ?? null,
        inputTokens: r.data.usage.prompt_tokens,
        outputTokens: r.data.usage.completion_tokens,
        cachedInputTokens:
          r.data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens:
          r.data.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        cost: r.data.usage.cost,
      };
    },
  });

export interface SuggestInput {
  user: PortalUser;
  text: string;
}

/**
 * One concierge suggestion: cap check, one Jev call (plus at most one
 * translation and a re-ask), then the pure rules in `decideSuggestion`.
 * Creates nothing. The text itself is never stored; the ledger gets hashes,
 * tokens and cost only.
 */
export const suggest = (
  input: SuggestInput,
): Effect.Effect<
  Suggestion,
  ConciergeError | DbFailure,
  DatabaseTag | ConciergeConfigTag
> =>
  Effect.gen(function* () {
    const config = yield* ConciergeConfigTag;
    const db = yield* DatabaseTag;
    const now = config.now();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const used = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ n: count() })
          .from(schema.agentRuns)
          .where(
            and(
              eq(schema.agentRuns.userId, input.user.id),
              eq(schema.agentRuns.kind, "concierge"),
              gte(schema.agentRuns.startedAt, dayStart),
            ),
          ),
      catch: (cause) => new DbFailure({ cause }),
    });
    if ((used[0]?.n ?? 0) >= config.dailyCap) {
      return yield* new ConciergeCapReached({ cap: config.dailyCap });
    }

    const run = yield* startAgentRun({
      kind: "concierge",
      purpose: "prod",
      userId: input.user.id,
    });
    const ctx: CallContext = {
      config,
      agentRunId: run.id,
      userId: input.user.id,
    };
    const suggestion = yield* Effect.gen(function* () {
      let jev = yield* askJev(ctx, input.text);
      let translated = false;
      if (
        jev.answers.is_english.noul < ENGLISH_MIN &&
        jev.answers.use_case.confidence < TRANSLATE_USE_CASE_MIN
      ) {
        const english = yield* translate(ctx, input.text);
        jev = yield* askJev(ctx, english);
        translated = true;
      }
      const a = jev.answers;
      const decision = decideSuggestion(
        {
          use_case: a.use_case,
          plan: a.plan,
          recipe: a.recipe,
          wants_gui: a.wants_gui.noul,
          players_connect: a.players_connect.noul,
          abuse: a.abuse.noul,
          is_english: a.is_english.noul,
        },
        { userTier: input.user.tier },
      );
      return { ...decision, translated, model: jev.model };
    }).pipe(
      Effect.tapErrorCause(() =>
        Effect.ignore(finishAgentRun(run.id, "failed")),
      ),
    );
    yield* finishAgentRun(run.id, "succeeded");
    return suggestion;
  }).pipe(
    // Ledger invariants we control; a violation is a bug, not a user error.
    Effect.catchTags({
      InvalidUsage: (e) => Effect.die(e),
      DuplicateLlmCall: (e) => Effect.die(e),
      AgentRunNotRunning: (e) => Effect.die(e),
    }),
  );
