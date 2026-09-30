import { describe, expect, test } from "bun:test";
import {
  ABUSE_REFUSE,
  ABUSE_REVIEW,
  PLAN_MIN,
  PLAYERS_MIN,
  RECIPE_MIN,
  SUGGEST_TEXT_MAX,
  SuggestBody,
  Suggestion,
  decideSuggestion,
} from "./concierge.js";
import type { ConciergeAnswers } from "./concierge.js";

type Overrides = {
  [K in keyof ConciergeAnswers]?: ConciergeAnswers[K] extends number
    ? number
    : Partial<ConciergeAnswers[K]>;
};

/** Confident vanilla-Minecraft answers; each test bends one slot. */
function answers(o: Overrides = {}): ConciergeAnswers {
  return {
    use_case: {
      choice: "game_server",
      probabilities: { game_server: 0.9, dev_box: 0.05 },
      confidence: 0.9,
      ...o.use_case,
    },
    plan: {
      choice: "game-small",
      probabilities: { "game-small": 0.9, "vm-medium": 0.08 },
      confidence: 0.9,
      ...o.plan,
    },
    recipe: {
      choice: "minecraft_java",
      probabilities: { minecraft_java: 0.9, minecraft_bedrock: 0.08 },
      confidence: 0.9,
      ...o.recipe,
    },
    wants_gui: o.wants_gui ?? 0.02,
    players_connect: o.players_connect ?? 0.1,
    abuse: o.abuse ?? 0.01,
    is_english: o.is_english ?? 0.99,
  };
}

const technical = { userTier: "technical" } as const;
const nontechnical = { userTier: "nontechnical" } as const;

describe("decideSuggestion", () => {
  test("confident answers suggest the plan and recipe as-is", () => {
    expect(decideSuggestion(answers(), nontechnical)).toEqual({
      outcome: "suggested",
      useCase: "game_server",
      planId: "game-small",
      recipeId: "minecraft_java",
      warnings: [],
    });
  });

  test("abuse at the refuse threshold refuses with nothing suggested", () => {
    expect(
      decideSuggestion(answers({ abuse: ABUSE_REFUSE }), technical),
    ).toEqual({
      outcome: "refused",
      useCase: null,
      planId: null,
      recipeId: null,
      warnings: [],
    });
  });

  test("grey-zone abuse keeps going and flags review", () => {
    const review = decideSuggestion(
      answers({ abuse: ABUSE_REVIEW }),
      technical,
    );
    expect(review.outcome).toBe("suggested");
    expect(review.warnings).toEqual(["needs_review"]);
    const almostRefused = decideSuggestion(
      answers({ abuse: ABUSE_REFUSE - 0.01 }),
      technical,
    );
    expect(almostRefused.outcome).toBe("suggested");
    expect(almostRefused.warnings).toEqual(["needs_review"]);
    expect(
      decideSuggestion(answers({ abuse: ABUSE_REVIEW - 0.01 }), technical)
        .warnings,
    ).toEqual([]);
  });

  test("not_offered use case returns no plan or recipe", () => {
    const d = decideSuggestion(
      answers({ use_case: { choice: "not_offered" } }),
      technical,
    );
    expect(d).toEqual({
      outcome: "not_offered",
      useCase: "not_offered",
      planId: null,
      recipeId: null,
      warnings: [],
    });
  });

  test("plan none is treated as not offered", () => {
    const d = decideSuggestion(
      answers({ plan: { choice: "none", confidence: 0.3 } }),
      technical,
    );
    expect(d.outcome).toBe("not_offered");
    expect(d.planId).toBeNull();
    expect(d.recipeId).toBeNull();
    expect(d.choice).toBeUndefined();
  });

  test("an unrequested desktop plan is demoted to the best headless plan", () => {
    const desktopPick = {
      choice: "desktop-ubuntu",
      probabilities: {
        "desktop-ubuntu": 0.6,
        "game-small": 0.1,
        "vm-medium": 0.25,
      },
    };
    const demoted = decideSuggestion(
      answers({
        use_case: { choice: "dev_box" },
        plan: desktopPick,
        recipe: { choice: "code_server" },
        wants_gui: 0.49,
      }),
      technical,
    );
    expect(demoted.planId).toBe("vm-medium");
    const wanted = decideSuggestion(
      answers({
        use_case: { choice: "dev_box" },
        plan: desktopPick,
        wants_gui: 0.5,
      }),
      technical,
    );
    expect(wanted.planId).toBe("desktop-ubuntu");
    const remote = decideSuggestion(
      answers({
        use_case: { choice: "remote_desktop" },
        plan: desktopPick,
        wants_gui: 0.1,
      }),
      technical,
    );
    expect(remote.planId).toBe("desktop-ubuntu");
  });

  test("a VM-only recipe upgrades a container plan to the smallest VM", () => {
    const d = decideSuggestion(
      answers({
        use_case: { choice: "always_on" },
        recipe: { choice: "docker" },
      }),
      technical,
    );
    expect(d.outcome).toBe("suggested");
    expect(d.planId).toBe("vm-medium");
    expect(d.recipeId).toBe("docker");
    expect(d.warnings).toEqual(["upgraded_for_recipe"]);
  });

  test("low plan confidence asks for a plan with the top 3 by probability", () => {
    const d = decideSuggestion(
      answers({
        plan: {
          confidence: PLAN_MIN - 0.01,
          probabilities: {
            "game-small": 0.3,
            none: 0.29,
            "vm-large": 0.05,
            "vm-medium": 0.2,
            "desktop-ubuntu": 0.1,
          },
        },
        recipe: { confidence: RECIPE_MIN - 0.2 },
      }),
      technical,
    );
    expect(d.outcome).toBe("choose");
    expect(d.planId).toBeNull();
    expect(d.recipeId).toBe("minecraft_java");
    expect(d.choice).toEqual({
      slot: "plan",
      options: [
        { id: "game-small", label: "Game Small", probability: 0.3 },
        { id: "vm-medium", label: "VM Medium", probability: 0.2 },
        { id: "desktop-ubuntu", label: "Desktop Ubuntu", probability: 0.1 },
      ],
    });
  });

  test("plan options skip container plans when the recipe needs a VM", () => {
    const d = decideSuggestion(
      answers({
        plan: {
          confidence: 0.4,
          probabilities: { "game-small": 0.4, "vm-medium": 0.3 },
        },
        recipe: { choice: "docker" },
      }),
      technical,
    );
    expect(d.choice?.options.map((o) => o.id)).not.toContain("game-small");
    expect(d.warnings).toEqual([]);
  });

  test("low recipe confidence asks for a recipe with the top 3 by probability", () => {
    const d = decideSuggestion(
      answers({
        recipe: {
          choice: "minecraft_java",
          confidence: RECIPE_MIN - 0.01,
          probabilities: {
            minecraft_java: 0.45,
            minecraft_bedrock: 0.44,
            valheim: 0.01,
            none: 0.1,
          },
        },
      }),
      technical,
    );
    expect(d.outcome).toBe("choose");
    expect(d.planId).toBe("game-small");
    expect(d.recipeId).toBeNull();
    expect(d.choice?.slot).toBe("recipe");
    expect(d.choice?.options.map((o) => o.id)).toEqual([
      "minecraft_java",
      "minecraft_bedrock",
      "none",
    ]);
    expect(
      decideSuggestion(
        answers({ recipe: { confidence: RECIPE_MIN } }),
        technical,
      ).outcome,
    ).toBe("suggested");
  });

  test("technical-only plans are still suggested but locked for nontechnical users", () => {
    const vm = answers({ plan: { choice: "vm-medium" } });
    const locked = decideSuggestion(vm, nontechnical);
    expect(locked.planId).toBe("vm-medium");
    expect(locked.warnings).toEqual(["plan_locked"]);
    expect(decideSuggestion(vm, technical).warnings).toEqual([]);
  });

  test("players connecting warns about IPv6 from the threshold up", () => {
    expect(
      decideSuggestion(answers({ players_connect: PLAYERS_MIN }), technical)
        .warnings,
    ).toEqual(["players_need_ipv6"]);
    expect(
      decideSuggestion(
        answers({ players_connect: PLAYERS_MIN - 0.01 }),
        technical,
      ).warnings,
    ).toEqual([]);
  });

  test("decisions satisfy the public Suggestion schema", () => {
    const d = decideSuggestion(
      answers({ plan: { confidence: 0.1 }, abuse: 0.5 }),
      nontechnical,
    );
    const parsed = Suggestion.safeParse({
      ...d,
      translated: false,
      model: "typesafe/jev-1.13",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("SuggestBody", () => {
  test("trims and bounds the text", () => {
    expect(SuggestBody.parse({ text: "  a bot  " })).toEqual({
      text: "a bot",
    });
    expect(SuggestBody.safeParse({ text: "   " }).success).toBe(false);
    expect(
      SuggestBody.safeParse({ text: "x".repeat(SUGGEST_TEXT_MAX) }).success,
    ).toBe(true);
    expect(
      SuggestBody.safeParse({ text: "x".repeat(SUGGEST_TEXT_MAX + 1) }).success,
    ).toBe(false);
  });
});
