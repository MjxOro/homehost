// Concierge contract: catalogs, request/response schemas and the pure rules that
// turn Jev's answers into a suggestion. No I/O here; the API owns the Jev call.
import { z } from "zod/v4";
import type { TrustTier } from "./control-plane.js";
import { PLANS, type Plan } from "./plans.js";

export const USE_CASE_IDS = [
  "game_server",
  "dev_box",
  "always_on",
  "remote_desktop",
  "learn_linux",
  "website",
  "not_offered",
] as const;
export type UseCaseId = (typeof USE_CASE_IDS)[number];

/** `description` doubles as the Jev criterion for the option. */
export const USE_CASES: Record<
  UseCaseId,
  { label: string; description: string }
> = {
  game_server: {
    label: "Game server",
    description:
      "Host a multiplayer game server (Minecraft, Valheim, ...) to play with friends",
  },
  dev_box: {
    label: "Dev box",
    description: "A remote Linux machine to write, build and test code",
  },
  always_on: {
    label: "Always-on app",
    description:
      "Keep a bot, script, scheduled job or small service running 24/7",
  },
  remote_desktop: {
    label: "Remote desktop",
    description: "A graphical Linux desktop used from the browser",
  },
  learn_linux: {
    label: "Learn Linux",
    description: "Learn Linux and the command line on a safe machine",
  },
  website: {
    label: "Website",
    description: "Host a website, blog or web app",
  },
  not_offered: {
    label: "Not offered",
    description:
      "Not offered here: GPU or AI model hosting, email servers, VPNs or proxies for other people, Windows, crypto mining",
  },
};

export const RECIPE_IDS = [
  "none",
  "node",
  "python",
  "docker",
  "code_server",
  "minecraft_java",
  "minecraft_bedrock",
  "valheim",
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

/** Setups suggested for first boot. `requiresVm`: cannot run in a container plan. */
export const RECIPES: Record<
  RecipeId,
  { label: string; description: string; requiresVm: boolean }
> = {
  none: {
    label: "Plain Ubuntu",
    description: "Plain Ubuntu, nothing extra installed",
    requiresVm: false,
  },
  node: {
    label: "Node.js",
    description: "Node.js runtime for JavaScript or TypeScript apps and bots",
    requiresVm: false,
  },
  python: {
    label: "Python",
    description: "Python runtime for scripts, bots and web apps",
    requiresVm: false,
  },
  docker: {
    label: "Docker",
    description: "Docker engine to run containerized apps",
    requiresVm: true,
  },
  code_server: {
    label: "VS Code in the browser",
    description: "VS Code in the browser (code-server) for coding",
    requiresVm: false,
  },
  minecraft_java: {
    label: "Minecraft Java",
    description: "Minecraft Java Edition server (PC and Mac players)",
    requiresVm: false,
  },
  minecraft_bedrock: {
    label: "Minecraft Bedrock",
    description: "Minecraft Bedrock server (console, phone, Windows players)",
    requiresVm: false,
  },
  valheim: {
    label: "Valheim",
    description: "Valheim dedicated server",
    requiresVm: false,
  },
};

/** Extra Jev plan option meaning "nothing in PLANS fits". */
export const PLAN_NONE = "none";

export const WARNING_CODES = [
  "needs_review",
  "upgraded_for_recipe",
  "plan_locked",
  "players_need_ipv6",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const SUGGESTION_OUTCOMES = [
  "suggested",
  "choose",
  "not_offered",
  "refused",
] as const;
export type SuggestionOutcome = (typeof SUGGESTION_OUTCOMES)[number];

export const SUGGEST_TEXT_MAX = 500;

export const SuggestBody = z.object({
  text: z.string().trim().min(1).max(SUGGEST_TEXT_MAX),
});
export type SuggestBody = z.infer<typeof SuggestBody>;

export const SuggestionChoice = z.object({
  slot: z.enum(["plan", "recipe"]),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      probability: z.number().min(0).max(1),
    }),
  ),
});
export type SuggestionChoice = z.infer<typeof SuggestionChoice>;

export const Suggestion = z.object({
  outcome: z.enum(SUGGESTION_OUTCOMES),
  useCase: z.enum(USE_CASE_IDS).nullable(),
  planId: z.string().nullable(),
  recipeId: z.enum(RECIPE_IDS).nullable(),
  /** Present only when `outcome` is `choose`. */
  choice: SuggestionChoice.optional(),
  /** Stable codes; the UI owns the copy. */
  warnings: z.array(z.enum(WARNING_CODES)),
  translated: z.boolean(),
  /** Versioned model id Jev reported. */
  model: z.string(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** The rules' part of a suggestion; the API adds `translated` and `model`. */
export type SuggestionDecision = Omit<Suggestion, "translated" | "model">;

export interface ChoiceAnswer<Id extends string> {
  choice: Id;
  probabilities: Partial<Record<Id, number>>;
  confidence: number;
}

/** Jev answers keyed by question id; noul answers are probabilities in [0, 1]. */
export interface ConciergeAnswers {
  use_case: ChoiceAnswer<UseCaseId>;
  /** A `PLANS` id or `PLAN_NONE`. */
  plan: ChoiceAnswer<string>;
  recipe: ChoiceAnswer<RecipeId>;
  wants_gui: number;
  players_connect: number;
  abuse: number;
  is_english: number;
}

/** abuse at or above this refuses outright. */
export const ABUSE_REFUSE = 0.8;
/** abuse at or above this (and below refuse) continues with `needs_review`. */
export const ABUSE_REVIEW = 0.4;
/** Plan choice confidence below this asks the user to pick a plan. */
export const PLAN_MIN = 0.5;
/** Recipe choice confidence below this asks the user to pick a recipe. */
export const RECIPE_MIN = 0.5;
/** wants_gui below this demotes an unrequested desktop plan. */
export const GUI_MIN = 0.5;
/** players_connect at or above this adds `players_need_ipv6`. */
export const PLAYERS_MIN = 0.6;
/** Options offered in a `choose` follow-up. */
export const CHOICE_OPTIONS = 3;

function probabilityOf<Id extends string>(
  answer: ChoiceAnswer<Id>,
  id: Id,
): number {
  return answer.probabilities[id] ?? 0;
}

/** Descending probability; ties keep catalog order (Array.sort is stable). */
function byProbability<T>(items: T[], probability: (t: T) => number): T[] {
  return [...items].sort((a, b) => probability(b) - probability(a));
}

/** Smaller of two plans by cpu, then memory, then disk. */
function smaller(a: Plan, b: Plan): Plan {
  const sa = [a.cpu, a.memoryMb, a.diskGb];
  const sb = [b.cpu, b.memoryMb, b.diskGb];
  for (let i = 0; i < sa.length; i++) {
    if (sa[i]! !== sb[i]!) return sa[i]! < sb[i]! ? a : b;
  }
  return a;
}

function orderWarnings(warnings: Set<WarningCode>): WarningCode[] {
  return WARNING_CODES.filter((w) => warnings.has(w));
}

/**
 * Every concierge rule, deterministic and I/O-free. Thresholds are the named
 * constants above; see docs/concierge.md.
 */
export function decideSuggestion(
  answers: ConciergeAnswers,
  opts: { userTier: TrustTier },
): SuggestionDecision {
  const warnings = new Set<WarningCode>();
  const empty = { planId: null, recipeId: null, warnings: [] };

  // 1. Abuse.
  if (answers.abuse >= ABUSE_REFUSE) {
    return { outcome: "refused", useCase: null, ...empty };
  }
  if (answers.abuse >= ABUSE_REVIEW) warnings.add("needs_review");

  // 2. Use case outside the offer.
  const useCase = answers.use_case.choice;
  const notOffered = (): SuggestionDecision => ({
    outcome: "not_offered",
    useCase,
    ...empty,
    warnings: orderWarnings(warnings),
  });
  if (useCase === "not_offered") return notOffered();

  // 3. Plan.
  if (answers.plan.choice === PLAN_NONE) return notOffered();
  let plan = PLANS.find((p) => p.id === answers.plan.choice);
  if (!plan) return notOffered();
  const planProbability = (p: Plan) => probabilityOf(answers.plan, p.id);
  if (
    plan.desktop &&
    useCase !== "remote_desktop" &&
    answers.wants_gui < GUI_MIN
  ) {
    plan = byProbability(
      PLANS.filter((p) => !p.desktop),
      planProbability,
    )[0]!;
  }
  const recipeId = answers.recipe.choice;
  const needsVm = RECIPES[recipeId].requiresVm;
  if (needsVm && plan.kind === "container") {
    plan = PLANS.filter((p) => p.kind === "vm" && !p.desktop).reduce(smaller);
    warnings.add("upgraded_for_recipe");
  }

  if (answers.players_connect >= PLAYERS_MIN) warnings.add("players_need_ipv6");

  // 4. Low confidence: one follow-up slot, plan first.
  if (answers.plan.confidence < PLAN_MIN) {
    const candidates = PLANS.filter(
      (p) => !(needsVm && p.kind === "container"),
    );
    warnings.delete("upgraded_for_recipe");
    return {
      outcome: "choose",
      useCase,
      planId: null,
      recipeId,
      choice: {
        slot: "plan",
        options: byProbability(candidates, planProbability)
          .slice(0, CHOICE_OPTIONS)
          .map((p) => ({
            id: p.id,
            label: p.name,
            probability: planProbability(p),
          })),
      },
      warnings: orderWarnings(warnings),
    };
  }

  // 5. Tier lock: still suggested, the create endpoint enforces tiers.
  if (plan.technicalOnly && opts.userTier === "nontechnical") {
    warnings.add("plan_locked");
  }

  if (answers.recipe.confidence < RECIPE_MIN) {
    return {
      outcome: "choose",
      useCase,
      planId: plan.id,
      recipeId: null,
      choice: {
        slot: "recipe",
        options: byProbability([...RECIPE_IDS], (id) =>
          probabilityOf(answers.recipe, id),
        )
          .slice(0, CHOICE_OPTIONS)
          .map((id) => ({
            id,
            label: RECIPES[id].label,
            probability: probabilityOf(answers.recipe, id),
          })),
      },
      warnings: orderWarnings(warnings),
    };
  }

  return {
    outcome: "suggested",
    useCase,
    planId: plan.id,
    recipeId,
    warnings: orderWarnings(warnings),
  };
}
