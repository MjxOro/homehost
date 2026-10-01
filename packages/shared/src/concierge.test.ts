import { describe, expect, test } from "bun:test";
import {
  ABUSE_REFUSE,
  ABUSE_REVIEW,
  CONCIERGE_RULES_VERSION,
  CONCIERGE_SCHEMA_VERSION,
  CONSOLE_MIN,
  GUI_MIN,
  PLAN_MIN,
  RECIPE_MIN,
  SCRAPING_REVIEW,
  SuggestBody,
  Suggestion,
  USE_CASE_MIN,
  decideSuggestion,
  eligiblePlans,
  needsTranslation,
} from "./concierge.js";
import { RECIPES, SUGGEST_TEXT_MAX } from "./concierge-catalog.js";
import { PLANS } from "./plans.js";
import type { ConciergeAnswers, SuggestionDecision } from "./concierge.js";

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
    console_player: o.console_player ?? 0.05,
    abuse: o.abuse ?? 0.01,
    scraping: o.scraping ?? 0.01,
    is_english: o.is_english ?? 0.99,
  };
}

const technical = { userTier: "technical" } as const;
const nontechnical = { userTier: "nontechnical" } as const;
const bot = {
  use_case: { choice: "always_on" },
  recipe: {
    choice: "node",
    probabilities: { node: 0.9, python: 0.05 },
  },
} as const satisfies Overrides;

function suggested(d: SuggestionDecision) {
  if (d.outcome !== "suggested")
    throw new Error(`expected suggested, got ${d.outcome}`);
  return d;
}

describe("decideSuggestion", () => {
  test("confident Minecraft answers produce a complete versioned suggestion", () => {
    expect(decideSuggestion(answers(), nontechnical)).toEqual({
      outcome: "suggested",
      useCase: "game_server",
      planId: "container-small",
      recipeId: "minecraft_java",
      warnings: [],
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
        warnings: [],
      });
    });

    test("grey-zone abuse keeps going and flags review", () => {
      for (const abuse of [ABUSE_REVIEW, ABUSE_REFUSE - 0.01]) {
        expect(
          suggested(decideSuggestion(answers({ ...bot, abuse }), technical))
            .warnings,
        ).toEqual(["needs_review"]);
      }
      expect(
        decideSuggestion(
          answers({ ...bot, abuse: ABUSE_REVIEW - 0.01 }),
          technical,
        ).warnings,
      ).toEqual([]);
    });

    test("scraping only ever flags review", () => {
      expect(
        suggested(decideSuggestion(answers({ ...bot, scraping: 1 }), technical))
          .warnings,
      ).toEqual(["needs_review"]);
      expect(
        decideSuggestion(
          answers({ ...bot, scraping: SCRAPING_REVIEW - 0.01 }),
          technical,
        ).warnings,
      ).toEqual([]);
    });
  });

  describe("use case and software defaults", () => {
    test("an unsure not-offered answer uses the top offered probability", () => {
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
          plan: { confidence: 0.1 },
        }),
        technical,
      );
      expect(suggested(d)).toMatchObject({
        useCase: "website",
        planId: "container-small",
        recipeId: "docker",
      });
    });

    test("an unsure offered use case keeps Jev's top choice", () => {
      expect(
        suggested(
          decideSuggestion(
            answers({
              use_case: { choice: "dev_box", confidence: 0.1 },
            }),
            technical,
          ),
        ),
      ).toMatchObject({ useCase: "dev_box", recipeId: "docker" });
    });

    test("only a confident not-offered use case is terminal", () => {
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
        useCase: "not_offered",
        planId: null,
        recipeId: null,
      });
    });

    test("bots, websites, dev boxes and Linux learners default to the smallest fitting Docker plan in either tier", () => {
      for (const tier of [technical, nontechnical]) {
        for (const choice of [
          "always_on",
          "website",
          "dev_box",
          "learn_linux",
        ] as const) {
          const d = decideSuggestion(
            answers({
              use_case: { choice },
              plan: { choice: "vm-large", confidence: PLAN_MIN - 0.01 },
              recipe: { choice: "python", confidence: 0.1 },
            }),
            tier,
          );
          expect(suggested(d)).toMatchObject({
            useCase: choice,
            recipeId: "docker",
            planId: "container-small",
            warnings: [],
          });
        }
      }
    });

    test("an unsure game uses the top game probability, ignoring non-games", () => {
      expect(
        suggested(
          decideSuggestion(
            answers({
              recipe: {
                choice: "node",
                confidence: 0.1,
                probabilities: {
                  node: 0.6,
                  python: 0.2,
                  minecraft_java: 0.04,
                  valheim: 0.1,
                  minecraft_bedrock: 0.06,
                },
              },
            }),
            nontechnical,
          ),
        ).recipeId,
      ).toBe("valheim");
      expect(RECIPES.valheim.installable).toBe(false);
    });

    test("games default to Minecraft Java without any positive game probability", () => {
      for (const probabilities of [{}, { node: 0.9, minecraft_bedrock: 0 }]) {
        expect(
          suggested(
            decideSuggestion(
              answers({ recipe: { choice: "node", probabilities } }),
              technical,
            ),
          ).recipeId,
        ).toBe("minecraft_java");
      }
    });

    test("game probability ties keep catalog order", () => {
      expect(
        suggested(
          decideSuggestion(
            answers({
              recipe: {
                choice: "valheim",
                probabilities: { valheim: 0.4, minecraft_bedrock: 0.4 },
              },
            }),
            technical,
          ),
        ).recipeId,
      ).toBe("minecraft_bedrock");
    });

    test("a remote desktop defaults to a desktop plan and plain software", () => {
      expect(
        suggested(
          decideSuggestion(
            answers({
              use_case: { choice: "remote_desktop" },
              plan: { confidence: 0.1 },
              recipe: { choice: "docker" },
            }),
            technical,
          ),
        ),
      ).toMatchObject({ planId: "desktop-ubuntu", recipeId: "none" });
    });
  });

  describe("plan and normalization", () => {
    test("only a confident plan none is terminal", () => {
      expect(
        decideSuggestion(
          answers({ plan: { choice: "none", confidence: PLAN_MIN } }),
          technical,
        ),
      ).toMatchObject({ outcome: "not_offered", reason: "no_fitting_plan" });
      expect(
        suggested(
          decideSuggestion(
            answers({ plan: { choice: "none", confidence: PLAN_MIN - 0.01 } }),
            technical,
          ),
        ).planId,
      ).toBe("container-small");
    });

    test("a confident VM plan for a bot is kept without shrinking", () => {
      for (const choice of ["vm-medium", "vm-large"]) {
        expect(
          suggested(
            decideSuggestion(
              answers({ ...bot, plan: { choice, confidence: PLAN_MIN } }),
              technical,
            ),
          ),
        ).toMatchObject({ planId: choice, recipeId: "docker", warnings: [] });
      }
    });

    test("unavailable and tier-locked plans are never suggested", () => {
      expect(eligiblePlans("technical").map((p) => p.id)).not.toContain(
        "desktop-omarchy",
      );
      expect(eligiblePlans("nontechnical").map((p) => p.id)).toEqual([
        "container-small",
      ]);
      expect(
        suggested(
          decideSuggestion(
            answers({
              use_case: { choice: "remote_desktop" },
              plan: { choice: "desktop-omarchy" },
            }),
            technical,
          ),
        ).planId,
      ).toBe("desktop-ubuntu");
      expect(
        suggested(
          decideSuggestion(
            answers({ ...bot, plan: { choice: "vm-medium" } }),
            nontechnical,
          ),
        ).planId,
      ).toBe("container-small");
    });

    test("a remote desktop without an eligible desktop plan is tier locked", () => {
      for (const choice of ["container-small", "none"]) {
        expect(
          decideSuggestion(
            answers({
              use_case: { choice: "remote_desktop" },
              plan: { choice },
            }),
            nontechnical,
          ),
        ).toMatchObject({ outcome: "not_offered", reason: "tier_locked" });
      }
    });

    test("a headless workload is moved off a desktop without shrinking", () => {
      const o = {
        ...bot,
        plan: { choice: "desktop-ubuntu" },
        wants_gui: GUI_MIN - 0.01,
      };
      expect(suggested(decideSuggestion(answers(o), technical))).toMatchObject({
        planId: "container-small",
        recipeId: "docker",
        warnings: [],
      });
      expect(
        suggested(
          decideSuggestion(answers({ ...o, wants_gui: GUI_MIN }), technical),
        ).planId,
      ).toBe("desktop-ubuntu");
    });

    test("a remote desktop never shrinks a larger headless answer silently", () => {
      expect(
        decideSuggestion(
          answers({
            use_case: { choice: "remote_desktop" },
            plan: { choice: "vm-large" },
          }),
          technical,
        ),
      ).toMatchObject({ outcome: "not_offered", reason: "no_fitting_plan" });
    });

    test("no available fitting plan returns not offered", () => {
      const desktop = PLANS.find((p) => p.id === "desktop-ubuntu")!;
      const available = desktop.available;
      try {
        desktop.available = false;
        expect(
          decideSuggestion(
            answers({ use_case: { choice: "remote_desktop" } }),
            technical,
          ),
        ).toMatchObject({ outcome: "not_offered", reason: "no_fitting_plan" });
      } finally {
        desktop.available = available;
      }
    });

    test("a future VM-only game upgrades once and preserves ordered warnings", () => {
      const requiresVm = RECIPES.valheim.requiresVm;
      try {
        RECIPES.valheim.requiresVm = true;
        expect(
          suggested(
            decideSuggestion(
              answers({
                recipe: { choice: "valheim", probabilities: { valheim: 1 } },
                abuse: ABUSE_REVIEW,
                console_player: CONSOLE_MIN,
              }),
              technical,
            ),
          ),
        ).toMatchObject({
          planId: "vm-medium",
          recipeId: "valheim",
          warnings: [
            "needs_review",
            "upgraded_for_recipe",
            "console_not_supported",
          ],
        });
        expect(
          decideSuggestion(
            answers({
              recipe: { choice: "valheim", probabilities: { valheim: 1 } },
            }),
            nontechnical,
          ),
        ).toMatchObject({ outcome: "not_offered", reason: "tier_locked" });
      } finally {
        RECIPES.valheim.requiresVm = requiresVm;
      }
    });
  });

  test("console players are warned only for game recipes", () => {
    expect(
      decideSuggestion(answers({ console_player: CONSOLE_MIN }), technical)
        .warnings,
    ).toEqual(["console_not_supported"]);
    expect(
      decideSuggestion(
        answers({ console_player: CONSOLE_MIN - 0.01 }),
        technical,
      ).warnings,
    ).toEqual([]);
    expect(
      decideSuggestion(answers({ ...bot, console_player: 1 }), technical)
        .warnings,
    ).toEqual([]);
  });
});

describe("needsTranslation", () => {
  test("only use case and game uncertainty matter", () => {
    expect(needsTranslation(answers())).toBe(false);
    expect(
      needsTranslation(
        answers({ use_case: { confidence: USE_CASE_MIN - 0.01 } }),
      ),
    ).toBe(true);
    expect(needsTranslation(answers({ plan: { confidence: 0.1 } }))).toBe(
      false,
    );
    expect(
      needsTranslation(answers({ recipe: { confidence: RECIPE_MIN - 0.01 } })),
    ).toBe(true);
    expect(
      needsTranslation(answers({ recipe: { confidence: RECIPE_MIN } })),
    ).toBe(false);
    expect(
      needsTranslation(answers({ ...bot, recipe: { confidence: 0.1 } })),
    ).toBe(false);
    expect(
      needsTranslation(
        answers({
          use_case: { choice: "remote_desktop" },
          recipe: { confidence: 0.1 },
        }),
      ),
    ).toBe(false);
    expect(
      needsTranslation(
        answers({
          use_case: { choice: "not_offered", confidence: USE_CASE_MIN },
          recipe: { confidence: 0.1 },
        }),
      ),
    ).toBe(false);
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

  test("rejects old schema versions and incoherent outcomes", () => {
    const bad = [
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
      {
        ...envelope,
        outcome: "suggested",
        useCase: "always_on",
        planId: "container-small",
        recipeId: "docker",
        schemaVersion: 1,
      },
    ];
    for (const value of bad) {
      expect(Suggestion.safeParse(value).success).toBe(false);
    }
  });
});

describe("SuggestBody", () => {
  test("trims and bounds the text", () => {
    expect(SuggestBody.parse({ text: "  a bot  " })).toEqual({ text: "a bot" });
    expect(SuggestBody.safeParse({ text: "   " }).success).toBe(false);
    expect(
      SuggestBody.safeParse({ text: "x".repeat(SUGGEST_TEXT_MAX) }).success,
    ).toBe(true);
    expect(
      SuggestBody.safeParse({ text: "x".repeat(SUGGEST_TEXT_MAX + 1) }).success,
    ).toBe(false);
  });

  test("accepts text only; old overrides and other unknown keys are rejected", () => {
    for (const body of [
      { text: "a bot", recipeId: "node" },
      { text: "a bot", model: "other" },
    ]) {
      expect(SuggestBody.safeParse(body).success).toBe(false);
    }
  });
});
