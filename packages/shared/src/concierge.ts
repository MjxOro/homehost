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
  WARNING_CODES,
  type NotOfferedReason,
  type RecipeId,
  type UseCaseId,
  type WarningCode,
} from "./concierge-catalog.js";
import { PLANS, type Plan } from "./plans.js";

/** Shape of the `Suggestion` JSON. Bump on breaking contract changes. */
export const CONCIERGE_SCHEMA_VERSION = 2;
/** Bump whenever a rule, threshold, question or catalog change can alter a suggestion. */
export const CONCIERGE_RULES_VERSION = "2026-10-01.3";

/** Extra Jev plan option meaning "nothing in PLANS fits". */
export const PLAN_NONE = "none";

/** abuse at or above this refuses outright. */
export const ABUSE_REFUSE = 0.8;
/** abuse at or above this (and below refuse) continues with `needs_review`. */
export const ABUSE_REVIEW = 0.4;
/** scraping at or above this adds `needs_review`; it never refuses. */
export const SCRAPING_REVIEW = 0.5;
/** Minimum confidence to treat a not-offered use case as terminal. */
export const USE_CASE_MIN = 0.5;
/** Minimum confidence to keep Jev's plan instead of using the smallest fit. */
export const PLAN_MIN = 0.5;
/** Minimum game recipe confidence before trying the translation fallback. */
export const RECIPE_MIN = 0.5;
/** wants_gui below this makes a workload headless (no desktop plans). */
export const GUI_MIN = 0.5;
/** console_player at or above this adds `console_not_supported` for game recipes. */
export const CONSOLE_MIN = 0.5;

const planId = z
  .string()
  .refine((id) => PLANS.some((p) => p.id === id), "unknown plan");

export const SuggestBody = z
  .object({
    text: z.string().trim().min(1).max(SUGGEST_TEXT_MAX),
  })
  .strict();
export type SuggestBody = z.infer<typeof SuggestBody>;

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

/** Highest positive probability; ties keep catalog order. */
function mostProbable<Id extends string>(
  ids: readonly Id[],
  answer: ChoiceAnswer<Id>,
  fallback: Id,
): Id {
  let best = fallback;
  let probability = 0;
  for (const id of ids) {
    const next = answer.probabilities[id] ?? 0;
    if (next > probability) {
      best = id;
      probability = next;
    }
  }
  return best;
}

function resolvedUseCase(answers: ConciergeAnswers): UseCaseId {
  if (
    answers.use_case.choice !== "not_offered" ||
    answers.use_case.confidence >= USE_CASE_MIN
  ) {
    return answers.use_case.choice;
  }
  return mostProbable(
    OFFERED_USE_CASE_IDS,
    answers.use_case,
    OFFERED_USE_CASE_IDS[0],
  );
}

/** Only uncertainty about the use case or a game merits a translated re-ask. */
export function needsTranslation(answers: ConciergeAnswers): boolean {
  const useCase = resolvedUseCase(answers);
  if (useCase === "not_offered") return false;
  return (
    answers.use_case.confidence < USE_CASE_MIN ||
    (useCase === "game_server" && answers.recipe.confidence < RECIPE_MIN)
  );
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
 * Every concierge rule, deterministic and I/O-free. Resolve software from the
 * use case, keep a confident fitting plan, otherwise use the smallest fit.
 * A confident plan that needs normalizing is never shrunk. The helper always
 * returns a complete suggestion or a terminal outcome; see docs/concierge.md.
 */
export function decideSuggestion(
  answers: ConciergeAnswers,
  opts: { userTier: TrustTier },
): SuggestionDecision {
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

  // 2. Use case: only a confident not-offered answer is terminal.
  const useCase = resolvedUseCase(answers);
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

  // 3. Software: game probabilities matter only among game recipes.
  const recipe: RecipeId =
    useCase === "game_server"
      ? mostProbable(
          RECIPE_IDS.filter((id) => RECIPES[id].game),
          answers.recipe,
          "minecraft_java",
        )
      : useCase === "remote_desktop"
        ? "none"
        : "docker";

  // Remote desktops need a desktop plan; headless workloads must not get one.
  const fitsWorkload = (p: Plan) =>
    useCase === "remote_desktop"
      ? p.desktop !== undefined
      : answers.wants_gui >= GUI_MIN || p.desktop === undefined;
  const fits = (p: Plan) => fitsWorkload(p) && planFitsRecipe(p, recipe);
  const eligible = eligiblePlans(opts.userTier);
  const candidates = eligible.filter(fits);
  if (candidates.length === 0) {
    return notOffered(
      PLANS.some((p) => p.available && fits(p))
        ? "tier_locked"
        : "no_fitting_plan",
    );
  }
  // Jev's confident "none" means the workload exceeds the listed sizes.
  if (answers.plan.confidence >= PLAN_MIN && answers.plan.choice === PLAN_NONE)
    return notOffered("no_fitting_plan");

  if (RECIPES[recipe].game && answers.console_player >= CONSOLE_MIN) {
    warnings.add("console_not_supported");
  }

  // 4. Keep a confident model plan, normalizing only when it does not fit.
  let plan =
    answers.plan.confidence >= PLAN_MIN
      ? eligible.find((p) => p.id === answers.plan.choice)
      : undefined;
  if (plan && !fits(plan)) {
    const from = plan;
    const larger = candidates.filter(
      (p) =>
        p.cpu >= from.cpu &&
        p.memoryMb >= from.memoryMb &&
        p.diskGb >= from.diskGb,
    );
    // No questions and no silent shrink when the required shape is too small.
    if (larger.length === 0) return notOffered("no_fitting_plan");
    plan = larger.reduce(smaller);
    if (!planFitsRecipe(from, recipe)) warnings.add("upgraded_for_recipe");
  }
  plan ??= candidates.reduce(smaller);

  return {
    outcome: "suggested",
    useCase,
    planId: plan.id,
    recipeId: recipe,
    warnings: orderedWarnings(),
    ...VERSIONS,
  };
}
