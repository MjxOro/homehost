import { describe, expect, test } from "bun:test";
import {
  ABUSE_REFUSE,
  ABUSE_REVIEW,
  CONCIERGE_RULES_VERSION,
  CONCIERGE_SCHEMA_VERSION,
  CONSOLE_MIN,
  GUI_MIN,
  PLAN_MIN,
  PLAYERS_MIN,
  RECIPE_MIN,
  SCRAPING_REVIEW,
  SuggestBody,
  Suggestion,
  USE_CASE_MIN,
  decideSuggestion,
  eligiblePlans,
  picksProblem,
  uncertainSlots,
} from "./concierge.js";
import { SUGGEST_TEXT_MAX } from "./concierge-catalog.js";
import type {
  ConciergeAnswers,
  SuggestPicks,
  SuggestionDecision,
} from "./concierge.js";

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
      choice: "container-small",
      probabilities: { "container-small": 0.9, "vm-medium": 0.08 },
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
    console_player: o.console_player ?? 0.05,
    abuse: o.abuse ?? 0.01,
    scraping: o.scraping ?? 0.01,
    is_english: o.is_english ?? 0.99,
  };
}

const technical = { userTier: "technical" } as const;
const nontechnical = { userTier: "nontechnical" } as const;

/** A confidently chosen non-game setup, so connection warnings stay quiet. */
const bot = {
  use_case: { choice: "always_on" },
  recipe: {
    choice: "node",
    probabilities: { node: 0.9, python: 0.05 },
  },
} as const satisfies Overrides;

function suggested(d: SuggestionDecision) {
  expect(d.outcome).toBe("suggested");
  return d;
}

function chosen(d: SuggestionDecision) {
  if (d.outcome !== "choose")
    throw new Error(`expected choose, got ${d.outcome}`);
  return d.choice;
}

describe("decideSuggestion", () => {
  test("confident answers suggest the plan and recipe as-is, versioned", () => {
    expect(decideSuggestion(answers(), nontechnical)).toEqual({
      outcome: "suggested",
      useCase: "game_server",
      planId: "container-small",
      recipeId: "minecraft_java",
      warnings: ["players_need_ipv6"],
      schemaVersion: CONCIERGE_SCHEMA_VERSION,
      rulesVersion: CONCIERGE_RULES_VERSION,
    });
  });

  describe("policy", () => {
    test("abuse at the refuse threshold refuses with nothing createable", () => {
      expect(
        decideSuggestion(answers({ abuse: ABUSE_REFUSE }), technical),
      ).toMatchObject({
        outcome: "refused",
        reason: "policy",
        useCase: null,
        planId: null,
        recipeId: null,
      });
    });

    test("grey-zone abuse keeps going and flags review", () => {
      for (const abuse of [ABUSE_REVIEW, ABUSE_REFUSE - 0.01]) {
        const d = suggested(
          decideSuggestion(answers({ ...bot, abuse }), technical),
        );
        expect(d.warnings).toEqual(["needs_review"]);
      }
      expect(
        decideSuggestion(
          answers({ ...bot, abuse: ABUSE_REVIEW - 0.01 }),
          technical,
        ).warnings,
      ).toEqual([]);
    });

    test("scraping only ever flags review", () => {
      const d = suggested(
        decideSuggestion(answers({ ...bot, scraping: 1 }), technical),
      );
      expect(d.warnings).toEqual(["needs_review"]);
      expect(
        decideSuggestion(
          answers({ ...bot, scraping: SCRAPING_REVIEW - 0.01 }),
          technical,
        ).warnings,
      ).toEqual([]);
    });
  });

  describe("use case", () => {
    test("an unsure use case asks with the top offered options", () => {
      const d = decideSuggestion(
        answers({
          use_case: {
            choice: "not_offered",
            confidence: USE_CASE_MIN - 0.01,
            probabilities: {
              not_offered: 0.4,
              website: 0.3,
              dev_box: 0.2,
              always_on: 0.05,
              game_server: 0.05,
            },
          },
        }),
        technical,
      );
      expect(d).toMatchObject({ useCase: null, planId: null, recipeId: null });
      expect(chosen(d)).toEqual({
        slot: "use_case",
        options: [
          { id: "website", label: expect.any(String), probability: 0.3 },
          { id: "dev_box", label: expect.any(String), probability: 0.2 },
          { id: "game_server", label: expect.any(String), probability: 0.05 },
        ],
      });
    });

    test("only a confident not_offered use case is terminal", () => {
      expect(
        decideSuggestion(
          answers({
            use_case: { choice: "not_offered", confidence: USE_CASE_MIN },
          }),
          technical,
        ),
      ).toMatchObject({
        outcome: "not_offered",
        reason: "unsupported_use_case",
        planId: null,
        recipeId: null,
      });
    });

    test("a picked use case overrides an unsure answer", () => {
      const d = decideSuggestion(
        answers({ use_case: { choice: "not_offered", confidence: 0.1 } }),
        { ...technical, picks: { useCase: "game_server" } },
      );
      expect(suggested(d).useCase).toBe("game_server");
    });
  });

  describe("plan", () => {
    test("only a confident plan none is terminal", () => {
      expect(
        decideSuggestion(
          answers({ plan: { choice: "none", confidence: PLAN_MIN } }),
          technical,
        ),
      ).toMatchObject({ outcome: "not_offered", reason: "no_fitting_plan" });
    });

    test("an unsure plan asks with the top 3 eligible plans, never none", () => {
      const d = decideSuggestion(
        answers({
          plan: {
            choice: "none",
            confidence: PLAN_MIN - 0.01,
            probabilities: {
              none: 0.4,
              "vm-large": 0.05,
              "container-small": 0.3,
              "vm-medium": 0.2,
            },
          },
        }),
        technical,
      );
      expect(d).toMatchObject({ planId: null, recipeId: "minecraft_java" });
      expect(chosen(d)).toEqual({
        slot: "plan",
        options: [
          { id: "container-small", label: "Container Small", probability: 0.3 },
          { id: "vm-medium", label: "VM Medium", probability: 0.2 },
          { id: "vm-large", label: "VM Large", probability: 0.05 },
        ],
      });
    });

    test("an unsure plan with a single eligible candidate needs no question", () => {
      const d = decideSuggestion(
        answers({ plan: { choice: "none", confidence: 0.3 } }),
        nontechnical,
      );
      expect(suggested(d).planId).toBe("container-small");
    });

    test("unavailable and tier-locked plans are never suggested", () => {
      expect(eligiblePlans("technical").map((p) => p.id)).not.toContain(
        "desktop-omarchy",
      );
      expect(eligiblePlans("nontechnical").map((p) => p.id)).toEqual([
        "container-small",
      ]);
      const omarchy = decideSuggestion(
        answers({
          use_case: { choice: "remote_desktop" },
          plan: { choice: "desktop-omarchy" },
          recipe: { choice: "none" },
          wants_gui: 0.95,
        }),
        technical,
      );
      expect(suggested(omarchy).planId).toBe("desktop-ubuntu");
      expect(
        decideSuggestion(
          answers({ plan: { choice: "vm-medium" } }),
          nontechnical,
        ).planId,
      ).toBe("container-small");
    });

    test("a remote desktop without an eligible desktop plan is tier locked", () => {
      // Jev sees only container-small here, so it may answer it or a confident none.
      for (const plan of [{ choice: "container-small" }, { choice: "none" }]) {
        expect(
          decideSuggestion(
            answers({
              use_case: { choice: "remote_desktop" },
              plan,
              recipe: { choice: "none" },
              wants_gui: 0.95,
            }),
            nontechnical,
          ),
        ).toMatchObject({ outcome: "not_offered", reason: "tier_locked" });
      }
    });
  });

  describe("normalizer", () => {
    test("an unsure recipe leaves a confident container plan alone", () => {
      const d = decideSuggestion(
        answers({
          ...bot,
          recipe: {
            choice: "docker",
            confidence: RECIPE_MIN - 0.01,
            probabilities: { docker: 0.4, node: 0.35, python: 0.25 },
          },
        }),
        technical,
      );
      expect(d).toMatchObject({ planId: "container-small", recipeId: null });
      expect(d.warnings).toEqual([]);
      expect(chosen(d).options.map((o) => o.id)).toEqual([
        "docker",
        "node",
        "python",
      ]);
    });

    test("recipe options skip setups no eligible plan can run", () => {
      const d = decideSuggestion(
        answers({
          ...bot,
          recipe: {
            confidence: 0.3,
            probabilities: { docker: 0.4, node: 0.35, python: 0.2, none: 0.05 },
          },
        }),
        nontechnical,
      );
      expect(chosen(d).options.map((o) => o.id)).toEqual([
        "node",
        "python",
        "none",
      ]);
    });

    test("a VM-only recipe upgrades a container plan to the smallest headless VM", () => {
      const d = suggested(
        decideSuggestion(
          answers({ ...bot, recipe: { choice: "docker" } }),
          technical,
        ),
      );
      expect(d).toMatchObject({ planId: "vm-medium", recipeId: "docker" });
      expect(d.warnings).toEqual(["upgraded_for_recipe"]);
    });

    test("a VM-only recipe without an eligible VM is tier locked", () => {
      expect(
        decideSuggestion(
          answers({ ...bot, recipe: { choice: "docker" } }),
          nontechnical,
        ),
      ).toMatchObject({ outcome: "not_offered", reason: "tier_locked" });
    });

    test("a desktop plan for a headless workload moves to a headless plan without shrinking", () => {
      const desktop = { choice: "desktop-ubuntu", confidence: 0.9 };
      const coding = suggested(
        decideSuggestion(
          answers({
            use_case: { choice: "dev_box" },
            plan: desktop,
            recipe: { choice: "code_server" },
            wants_gui: GUI_MIN - 0.01,
          }),
          technical,
        ),
      );
      expect(coding.planId).toBe("container-small");
      expect(coding.warnings).toEqual([]);
      const docker = suggested(
        decideSuggestion(
          answers({
            use_case: { choice: "dev_box" },
            plan: desktop,
            recipe: { choice: "docker" },
            wants_gui: GUI_MIN - 0.01,
          }),
          technical,
        ),
      );
      // The desktop was already a VM: moving off it is not an upgrade.
      expect(docker).toMatchObject({ planId: "vm-medium", warnings: [] });
      const wanted = decideSuggestion(
        answers({
          use_case: { choice: "dev_box" },
          plan: desktop,
          recipe: { choice: "code_server" },
          wants_gui: 0.9,
        }),
        technical,
      );
      expect(wanted.planId).toBe("desktop-ubuntu");
    });

    test("a remote desktop never shrinks a larger headless answer silently", () => {
      const d = decideSuggestion(
        answers({
          use_case: { choice: "remote_desktop" },
          plan: { choice: "vm-large", probabilities: { "vm-large": 0.9 } },
          recipe: { choice: "none" },
          wants_gui: 0.95,
        }),
        technical,
      );
      expect(chosen(d)).toMatchObject({
        slot: "plan",
        options: [{ id: "desktop-ubuntu" }],
      });
    });
  });

  describe("picks", () => {
    test("a picked plan is never rewritten; an incompatible recipe is asked again", () => {
      const d = decideSuggestion(
        answers({ ...bot, recipe: { choice: "docker" } }),
        { ...technical, picks: { planId: "container-small" } },
      );
      expect(d).toMatchObject({ planId: "container-small", recipeId: null });
      expect(chosen(d).options.map((o) => o.id)).not.toContain("docker");
    });

    test("picked plan and recipe are final and need no upgrade", () => {
      const d = decideSuggestion(
        answers({
          ...bot,
          plan: { confidence: 0.1 },
          recipe: { confidence: 0.1 },
        }),
        { ...technical, picks: { planId: "vm-medium", recipeId: "docker" } },
      );
      expect(suggested(d)).toMatchObject({
        planId: "vm-medium",
        recipeId: "docker",
        warnings: [],
      });
    });

    test("picksProblem rejects ineligible plans and incompatible pairs", () => {
      const cases: [
        SuggestPicks | undefined,
        "technical" | "nontechnical",
        boolean,
      ][] = [
        [undefined, "nontechnical", false],
        [{ recipeId: "docker" }, "nontechnical", false],
        [{ planId: "container-small" }, "nontechnical", false],
        [{ planId: "vm-medium" }, "nontechnical", true],
        [{ planId: "desktop-omarchy" }, "technical", true],
        [{ planId: "container-small", recipeId: "docker" }, "technical", true],
        [{ planId: "vm-medium", recipeId: "docker" }, "technical", false],
      ];
      for (const [picks, tier, rejected] of cases) {
        expect(picksProblem(picks, tier) !== null).toBe(rejected);
      }
    });
  });

  describe("connection warnings", () => {
    test("game recipes always warn about IPv6; other recipes from the threshold", () => {
      expect(
        decideSuggestion(answers({ players_connect: 0 }), technical).warnings,
      ).toEqual(["players_need_ipv6"]);
      expect(
        decideSuggestion(
          answers({ ...bot, players_connect: PLAYERS_MIN }),
          technical,
        ).warnings,
      ).toEqual(["players_need_ipv6"]);
      expect(
        decideSuggestion(
          answers({ ...bot, players_connect: PLAYERS_MIN - 0.01 }),
          technical,
        ).warnings,
      ).toEqual([]);
    });

    test("console players are warned only for game recipes", () => {
      expect(
        decideSuggestion(answers({ console_player: CONSOLE_MIN }), technical)
          .warnings,
      ).toEqual(["players_need_ipv6", "console_not_supported"]);
      expect(
        decideSuggestion(
          answers({ console_player: CONSOLE_MIN - 0.01 }),
          technical,
        ).warnings,
      ).toEqual(["players_need_ipv6"]);
      expect(
        decideSuggestion(answers({ ...bot, console_player: 1 }), technical)
          .warnings,
      ).toEqual([]);
    });
  });
});

describe("uncertainSlots", () => {
  test("lists unpicked slots below their thresholds", () => {
    expect(uncertainSlots(answers())).toEqual([]);
    expect(
      uncertainSlots(
        answers({
          use_case: { confidence: 0.2 },
          plan: { confidence: 0.2 },
          recipe: { confidence: 0.2 },
        }),
      ),
    ).toEqual(["use_case", "plan", "recipe"]);
    expect(
      uncertainSlots(answers({ plan: { confidence: 0.2 } }), {
        planId: "container-small",
      }),
    ).toEqual([]);
    expect(
      uncertainSlots(
        answers({
          use_case: { choice: "not_offered", confidence: 0.9 },
          plan: { confidence: 0.1 },
        }),
      ),
    ).toEqual([]);
  });
});

describe("Suggestion schema", () => {
  const envelope = {
    warnings: [],
    translated: false,
    model: "typesafe/jev-1.13",
    schemaVersion: CONCIERGE_SCHEMA_VERSION,
    rulesVersion: CONCIERGE_RULES_VERSION,
  };

  test("accepts every decision the rules produce", () => {
    const decisions = [
      decideSuggestion(answers(), technical),
      decideSuggestion(answers({ abuse: 1 }), technical),
      decideSuggestion(answers({ plan: { confidence: 0.1 } }), technical),
      decideSuggestion(answers({ use_case: { confidence: 0.1 } }), technical),
      decideSuggestion(answers({ recipe: { confidence: 0.1 } }), technical),
      decideSuggestion(
        answers({ use_case: { choice: "not_offered" } }),
        technical,
      ),
    ];
    for (const d of decisions) {
      expect(Suggestion.safeParse({ ...d, ...envelope }).success).toBe(true);
    }
  });

  test("rejects incoherent outcomes", () => {
    const choose = {
      ...envelope,
      outcome: "choose",
      useCase: "game_server",
      planId: null,
      recipeId: null,
    };
    const option = {
      id: "container-small",
      label: "Container Small",
      probability: 0.5,
    };
    const bad = [
      choose,
      { ...choose, choice: { slot: "plan", options: [] } },
      { ...choose, choice: { slot: "plan", options: [option, option] } },
      {
        ...choose,
        choice: { slot: "plan", options: [{ ...option, id: "nope" }] },
      },
      {
        ...envelope,
        outcome: "refused",
        reason: "policy",
        useCase: null,
        planId: "container-small",
        recipeId: "node",
      },
      {
        ...envelope,
        outcome: "suggested",
        useCase: "remote_desktop",
        planId: "desktop-omarchy",
        recipeId: "none",
      },
      {
        ...envelope,
        outcome: "not_offered",
        useCase: "game_server",
        planId: null,
        recipeId: null,
      },
    ];
    for (const value of bad) {
      expect(Suggestion.safeParse(value).success).toBe(false);
    }
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

  test("accepts catalog picks and nothing else", () => {
    expect(
      SuggestBody.safeParse({
        text: "a bot",
        picks: {
          useCase: "always_on",
          planId: "container-small",
          recipeId: "node",
        },
      }).success,
    ).toBe(true);
    for (const body of [
      { text: "a bot", picks: { planId: "huge" } },
      { text: "a bot", picks: { useCase: "not_offered" } },
      { text: "a bot", picks: { model: "other" } },
      { text: "a bot", model: "other" },
    ]) {
      expect(SuggestBody.safeParse(body).success).toBe(false);
    }
  });
});
