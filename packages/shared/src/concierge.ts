// Concierge contract: request/response schemas and the pure rules that turn
// Jev's answers into a suggestion. Catalogs live in concierge-catalog.ts. No
// I/O here; the API owns the Jev call.
import { z } from "zod/v4";
import type { TrustTier } from "./control-plane.js";
import {
  NOT_OFFERED_REASONS,
  OFFERED_USE_CASE_IDS,
  RECIPE_IDS,
  RECIPES,
  SUGGEST_TEXT_MAX,
  USE_CASE_IDS,
  USE_CASES,
  WARNING_CODES,
  type ChoiceSlot,
  type NotOfferedReason,
  type RecipeId,
  type UseCaseId,
  type WarningCode,
} from "./concierge-catalog.js";
import { PLANS, type Plan } from "./plans.js";

/** Shape of the `Suggestion` JSON. Bump on breaking contract changes. */
export const CONCIERGE_SCHEMA_VERSION = 1;
/** Bump whenever a rule, threshold, question or catalog change can alter a suggestion. */
export const CONCIERGE_RULES_VERSION = "2026-10-01.1";

/** Extra Jev plan option meaning "nothing in PLANS fits". */
export const PLAN_NONE = "none";

/** abuse at or above this refuses outright. */
export const ABUSE_REFUSE = 0.8;
/** abuse at or above this (and below refuse) continues with `needs_review`. */
export const ABUSE_REVIEW = 0.4;
/** scraping at or above this adds `needs_review`; it never refuses. */
export const SCRAPING_REVIEW = 0.5;
/** Use case confidence below this asks the user to pick a use case. */
export const USE_CASE_MIN = 0.5;
/** Plan confidence below this asks the user to pick a plan. */
export const PLAN_MIN = 0.5;
/** Recipe confidence below this asks the user to pick a recipe. */
export const RECIPE_MIN = 0.5;
/** wants_gui below this makes a workload headless (no desktop plans). */
export const GUI_MIN = 0.5;
/** console_player at or above this adds `console_not_supported` for game recipes. */
export const CONSOLE_MIN = 0.5;
/** Most options offered in a `choose` follow-up. */
export const CHOICE_OPTIONS = 3;

const planId = z
  .string()
  .refine((id) => PLANS.some((p) => p.id === id), "unknown plan");

/** Answers to an earlier `choose`, applied as overrides; the call stays stateless. */
export const SuggestPicks = z
  .object({
    useCase: z.enum(OFFERED_USE_CASE_IDS).optional(),
    planId: planId.optional(),
    recipeId: z.enum(RECIPE_IDS).optional(),
  })
  .strict();
export type SuggestPicks = z.infer<typeof SuggestPicks>;

export const SuggestBody = z
  .object({
    text: z.string().trim().min(1).max(SUGGEST_TEXT_MAX),
    picks: SuggestPicks.optional(),
  })
  .strict();
export type SuggestBody = z.infer<typeof SuggestBody>;

const choiceOptions = <Id extends z.ZodType<string>>(id: Id) =>
  z
    .array(
      z.object({
        id,
        label: z.string(),
        probability: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(CHOICE_OPTIONS);

export const SuggestionChoice = z
  .discriminatedUnion("slot", [
    z.object({
      slot: z.literal("use_case"),
      options: choiceOptions(z.enum(OFFERED_USE_CASE_IDS)),
    }),
    z.object({ slot: z.literal("plan"), options: choiceOptions(planId) }),
    z.object({
      slot: z.literal("recipe"),
      options: choiceOptions(z.enum(RECIPE_IDS)),
    }),
  ])
  .refine(
    (c) => new Set(c.options.map((o) => o.id)).size === c.options.length,
    "options must be distinct",
  );
export type SuggestionChoice = z.infer<typeof SuggestionChoice>;

const envelope = {
  /** Stable codes; the UI owns the copy. */
  warnings: z.array(z.enum(WARNING_CODES)),
  translated: z.boolean(),
  /** Versioned model id Jev reported. */
  model: z.string(),
  schemaVersion: z.literal(CONCIERGE_SCHEMA_VERSION),
  rulesVersion: z.string(),
};

export const Suggestion = z.discriminatedUnion("outcome", [
  /** A complete, createable configuration. */
  z.object({
    outcome: z.literal("suggested"),
    useCase: z.enum(OFFERED_USE_CASE_IDS),
    planId: planId.refine(
      (id) => PLANS.some((p) => p.id === id && p.available),
      "plan unavailable",
    ),
    recipeId: z.enum(RECIPE_IDS),
    ...envelope,
  }),
  /** One slot needs the user; resolved slots so far are informational only. */
  z.object({
    outcome: z.literal("choose"),
    useCase: z.enum(OFFERED_USE_CASE_IDS).nullable(),
    planId: planId.nullable(),
    recipeId: z.enum(RECIPE_IDS).nullable(),
    choice: SuggestionChoice,
    ...envelope,
  }),
  z.object({
    outcome: z.literal("not_offered"),
    reason: z.enum(NOT_OFFERED_REASONS),
    useCase: z.enum(USE_CASE_IDS).nullable(),
    planId: z.null(),
    recipeId: z.null(),
    ...envelope,
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.literal("policy"),
    useCase: z.null(),
    planId: z.null(),
    recipeId: z.null(),
    ...envelope,
  }),
]);
export type Suggestion = z.infer<typeof Suggestion>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** The rules' part of a suggestion; the API adds `translated` and `model`. */
export type SuggestionDecision = DistributiveOmit<
  Suggestion,
  "translated" | "model"
>;

export interface ChoiceAnswer<Id extends string> {
  choice: Id;
  probabilities: Partial<Record<Id, number>>;
  confidence: number;
}

/** Jev answers keyed by question id; noul answers are probabilities in [0, 1]. */
export interface ConciergeAnswers {
  use_case: ChoiceAnswer<UseCaseId>;
  /** An eligible `PLANS` id or `PLAN_NONE`. */
  plan: ChoiceAnswer<string>;
  recipe: ChoiceAnswer<RecipeId>;
  wants_gui: number;
  console_player: number;
  abuse: number;
  scraping: number;
  is_english: number;
}

/** Plans this tier may create right now: available, and not tier-locked. */
export function eligiblePlans(tier: TrustTier): Plan[] {
  return PLANS.filter(
    (p) => p.available && (!p.technicalOnly || tier === "technical"),
  );
}

export function planFitsRecipe(plan: Plan, recipeId: RecipeId): boolean {
  return !RECIPES[recipeId].requiresVm || plan.kind === "vm";
}

/** Why `picks` cannot be honored for this tier (a 400), or null. */
export function picksProblem(
  picks: SuggestPicks | undefined,
  tier: TrustTier,
): string | null {
  if (!picks?.planId) return null;
  const plan = eligiblePlans(tier).find((p) => p.id === picks.planId);
  if (!plan) return "picked plan is not available to this account";
  if (picks.recipeId && !planFitsRecipe(plan, picks.recipeId)) {
    return "picked recipe does not run on the picked plan";
  }
  return null;
}

/**
 * Slots whose answer is too unsure to use and that the user has not picked.
 * Empty when the use case is confidently not offered (nothing else matters).
 */
export function uncertainSlots(
  answers: ConciergeAnswers,
  picks: SuggestPicks = {},
): ChoiceSlot[] {
  const useCaseSure = answers.use_case.confidence >= USE_CASE_MIN;
  if (
    !picks.useCase &&
    useCaseSure &&
    answers.use_case.choice === "not_offered"
  )
    return [];
  const slots: ChoiceSlot[] = [];
  if (!picks.useCase && !useCaseSure) slots.push("use_case");
  if (!picks.planId && answers.plan.confidence < PLAN_MIN) slots.push("plan");
  if (!picks.recipeId && answers.recipe.confidence < RECIPE_MIN)
    slots.push("recipe");
  return slots;
}

/** Top options by descending probability; ties keep catalog order (stable sort). */
function topOptions<Id extends string>(
  ids: readonly Id[],
  answer: ChoiceAnswer<string>,
  label: (id: Id) => string,
) {
  return [...ids]
    .sort(
      (a, b) => (answer.probabilities[b] ?? 0) - (answer.probabilities[a] ?? 0),
    )
    .slice(0, CHOICE_OPTIONS)
    .map((id) => ({
      id,
      label: label(id),
      probability: answer.probabilities[id] ?? 0,
    }));
}

/** Smallest of two plans by cpu, then memory, then disk. */
function smaller(a: Plan, b: Plan): Plan {
  const sa = [a.cpu, a.memoryMb, a.diskGb];
  const sb = [b.cpu, b.memoryMb, b.diskGb];
  for (let i = 0; i < sa.length; i++) {
    if (sa[i]! !== sb[i]!) return sa[i]! < sb[i]! ? a : b;
  }
  return a;
}

const VERSIONS = {
  schemaVersion: CONCIERGE_SCHEMA_VERSION,
  rulesVersion: CONCIERGE_RULES_VERSION,
} as const;

/**
 * Every concierge rule, deterministic and I/O-free. Uncertain slots are
 * resolved first (use case, then plan, then recipe; one `choose` per
 * response); the plan is then normalized once against the workload and the
 * recipe. Picks override Jev and are never rewritten. Thresholds are the
 * named constants above; see docs/concierge.md.
 */
export function decideSuggestion(
  answers: ConciergeAnswers,
  opts: { userTier: TrustTier; picks?: SuggestPicks },
): SuggestionDecision {
  const picks = opts.picks ?? {};
  const warnings = new Set<WarningCode>();
  const orderedWarnings = () => WARNING_CODES.filter((w) => warnings.has(w));

  // 1. Policy.
  if (answers.abuse >= ABUSE_REFUSE) {
    return {
      outcome: "refused",
      reason: "policy",
      useCase: null,
      planId: null,
      recipeId: null,
      warnings: [],
      ...VERSIONS,
    };
  }
  if (answers.abuse >= ABUSE_REVIEW || answers.scraping >= SCRAPING_REVIEW) {
    warnings.add("needs_review");
  }

  // 2. Use case.
  const useCase =
    picks.useCase ??
    (answers.use_case.confidence >= USE_CASE_MIN
      ? answers.use_case.choice
      : null);
  const notOffered = (reason: NotOfferedReason): SuggestionDecision => ({
    outcome: "not_offered",
    reason,
    useCase,
    planId: null,
    recipeId: null,
    warnings: orderedWarnings(),
    ...VERSIONS,
  });
  if (useCase === "not_offered") return notOffered("unsupported_use_case");
  if (useCase === null) {
    return {
      outcome: "choose",
      useCase: null,
      planId: null,
      recipeId: null,
      choice: {
        slot: "use_case",
        options: topOptions(
          OFFERED_USE_CASE_IDS,
          answers.use_case,
          (id) => USE_CASES[id].label,
        ),
      },
      warnings: orderedWarnings(),
      ...VERSIONS,
    };
  }

  // 3. Plan and recipe slots, without rewriting anything yet.
  const eligible = eligiblePlans(opts.userTier);
  const lockReason = (fits: (p: Plan) => boolean): NotOfferedReason =>
    PLANS.some((p) => p.available && fits(p))
      ? "tier_locked"
      : "no_fitting_plan";
  let plan: Plan | undefined;
  const planPinned = picks.planId !== undefined;
  if (planPinned) {
    plan = eligible.find((p) => p.id === picks.planId);
    if (!plan) return notOffered(lockReason((p) => p.id === picks.planId));
  } else if (answers.plan.confidence >= PLAN_MIN) {
    plan = eligible.find((p) => p.id === answers.plan.choice);
  }
  const planNoneSure =
    !planPinned &&
    answers.plan.confidence >= PLAN_MIN &&
    answers.plan.choice === PLAN_NONE;
  let recipe: RecipeId | null =
    picks.recipeId ??
    (answers.recipe.confidence >= RECIPE_MIN ? answers.recipe.choice : null);
  // A picked plan wins over a recipe it cannot run: ask for the recipe again.
  if (plan && planPinned && recipe && !planFitsRecipe(plan, recipe)) {
    recipe = null;
  }

  // Remote desktops need a desktop plan; headless workloads must not get one.
  const fitsWorkload = (p: Plan) =>
    useCase === "remote_desktop"
      ? p.desktop !== undefined
      : answers.wants_gui >= GUI_MIN || p.desktop === undefined;
  const fits = (p: Plan) =>
    fitsWorkload(p) && (recipe === null || planFitsRecipe(p, recipe));
  const candidates = eligible.filter(fits);
  // Jev only sees eligible plans: when none of them fits but a tier-locked
  // one would, say so instead of "nothing fits".
  if (!planPinned && candidates.length === 0)
    return notOffered(lockReason(fits));
  if (planNoneSure) return notOffered("no_fitting_plan");

  const game = recipe !== null && RECIPES[recipe].game;
  if (game && answers.console_player >= CONSOLE_MIN) {
    warnings.add("console_not_supported");
  }

  // 4. Normalize a model-chosen plan: the smallest fitting plan that is at
  // least as large. Never shrink; if none exists, ask instead.
  let mustAsk = false;
  if (plan && !planPinned && !fits(plan)) {
    const from = plan;
    const larger = candidates.filter(
      (p) =>
        p.cpu >= from.cpu &&
        p.memoryMb >= from.memoryMb &&
        p.diskGb >= from.diskGb,
    );
    plan = larger.length > 0 ? larger.reduce(smaller) : undefined;
    mustAsk = plan === undefined;
    if (plan && recipe !== null && !planFitsRecipe(from, recipe)) {
      warnings.add("upgraded_for_recipe");
    }
  }

  // 5. Follow-ups, plan first. A single candidate needs no question unless
  // taking it would shrink a plan Jev was sure about.
  if (!plan) {
    if (candidates.length === 1 && !mustAsk) {
      plan = candidates[0]!;
    } else {
      return {
        outcome: "choose",
        useCase,
        planId: null,
        recipeId: recipe,
        choice: {
          slot: "plan",
          options: topOptions(
            candidates.map((p) => p.id),
            answers.plan,
            (id) => PLANS.find((p) => p.id === id)!.name,
          ),
        },
        warnings: orderedWarnings(),
        ...VERSIONS,
      };
    }
  }
  if (recipe === null) {
    const planNow = plan;
    // Offer only recipes some eligible plan can run (the picked one, if any).
    const options = RECIPE_IDS.filter((id) =>
      planPinned
        ? planFitsRecipe(planNow, id)
        : eligible.some((p) => fitsWorkload(p) && planFitsRecipe(p, id)),
    );
    return {
      outcome: "choose",
      useCase,
      planId: plan.id,
      recipeId: null,
      choice: {
        slot: "recipe",
        options: topOptions(options, answers.recipe, (id) => RECIPES[id].label),
      },
      warnings: orderedWarnings(),
      ...VERSIONS,
    };
  }

  return {
    outcome: "suggested",
    useCase,
    planId: plan.id,
    recipeId: recipe,
    warnings: orderedWarnings(),
    ...VERSIONS,
  };
}
