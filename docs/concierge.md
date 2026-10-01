# Concierge

`POST /api/concierge/suggest` turns a free-text wish ("vanilla minecraft for me
and 4 friends") into a suggested use case, plan and first-boot recipe. It
never asks follow-up questions and creates nothing: the client shows a confirm
card and then calls the existing
`POST /api/requests`, which enforces tiers and quotas on its own. Installable
recipes are then set up by the worker once the box is running (see
[recipes.md](recipes.md)); "coming soon" recipes are only suggested. A refusal
is advice, not enforcement: nothing stops a user from creating a plain request
directly.

## Request

Approved users (and operators) only. Body (`SuggestBody` in
`@homehost/shared`, strict: unknown keys are a 400):

```json
{
  "text": "vanilla minecraft for me and 4 friends"
}
```

`text` is trimmed, 1 to 500 characters. It is the only accepted field. Every
call independently resolves the use case, software and plan; callers do not
send overrides or answers to follow-up questions.

## Response

A `Suggestion`, a union on `outcome`, always carrying `warnings`,
`translated`, `model` (the versioned id Jev reported), `schemaVersion` (`2`)
and `rulesVersion` (`CONCIERGE_RULES_VERSION`, bumped whenever rules,
questions or catalogs change):

| outcome       | fields                                                                                  |
| ------------- | --------------------------------------------------------------------------------------- |
| `suggested`   | `useCase`, `planId`, `recipeId`: a complete configuration the user can create           |
| `not_offered` | `reason`: `unsupported_use_case`, `no_fitting_plan` or `tier_locked`; no plan or recipe |
| `refused`     | `reason: "policy"`; no use case, plan or recipe                                         |

Warning codes (the UI owns the copy): `needs_review` (abuse score in the grey
zone, or scraping), `upgraded_for_recipe` (the final plan was enlarged to a VM
because the final recipe needs one), `console_not_supported` (console players
cannot join a self-hosted game server).

Errors use the usual `{ error, code }` shape:

| status | code                    | when                                                                |
| ------ | ----------------------- | ------------------------------------------------------------------- |
| 400    | `invalid`               | body fails `SuggestBody`                                            |
| 429    | `concierge_cap`         | daily cap reached                                                   |
| 502    | `concierge_upstream`    | provider error, malformed answer, cut-off translation, deadline hit |
| 503    | `concierge_unavailable` | `OPENROUTER_API_KEY` unset                                          |

## How it decides

1. Admission: one transaction locks the user row, counts today's (UTC)
   concierge `agent_runs` in any status, refuses at the cap and otherwise
   inserts the run. Only then does any network call happen, so a burst
   cannot overshoot the cap.
2. One Jev request (`typesafe/jev-1.13`, OpenRouter `POST /api/alpha/decisions`)
   asks everything at once: `use_case`, `plan`, `recipe` (choices built from
   `USE_CASES`, `RECIPES` and the plans this user's tier can create right
   now), and the probabilities `wants_gui`, `console_player`, `abuse`,
   `scraping`, `is_english`. Questions live in
   `apps/api/src/domain/concierge.ts`.
3. Translation fallback, at most once: when the text is not English
   (`is_english < ENGLISH_MIN`, 0.5) and either the use case is unsure or a
   resolved `game_server` recipe is unsure, the text is translated with
   `deepseek/deepseek-v4.1-flash` and Jev is asked
   again. Plan uncertainty and non-game recipe uncertainty never trigger
   translation. A confident `not_offered` use case or policy refusal on the
   original pass is terminal. Even if the second pass stays unsure, no
   second translation is attempted. `abuse` and
   `scraping` keep the higher value of the two passes. A translation that is
   empty or cut off (`finish_reason` other than `stop`) fails the request.
4. `decideSuggestion` (pure, `packages/shared/src/concierge.ts`):
   - policy: `abuse >= ABUSE_REFUSE` (0.8) refuses; `abuse >= ABUSE_REVIEW`
     (0.4) or `scraping >= SCRAPING_REVIEW` (0.5) adds `needs_review`.
     Scraping never refuses.
   - use case: take Jev's top choice even below `USE_CASE_MIN` (0.5).
     Only a `not_offered` choice at or above that threshold is terminal;
     below it, take the highest-probability offered use case. Ties keep
     catalog order, including when all offered probabilities are absent.
   - software: `game_server` takes the most probable game recipe, ignoring
     all non-game probabilities and recipe confidence. If no game has a
     positive probability, use `minecraft_java`. `remote_desktop` uses
     `none`; every other offered use case uses `docker`. Non-installable
     games keep the "coming soon" UI and create plain Ubuntu instead.
   - eligibility: only available plans the tier may create
     (`eligiblePlans`); `desktop-omarchy` is unavailable. A remote desktop
     needs a desktop plan; a headless workload (`wants_gui < GUI_MIN`, 0.5)
     never gets one. When no eligible plan fits the workload and recipe but a
     tier-locked one would, the outcome is `not_offered` `tier_locked`;
     otherwise it is `no_fitting_plan`.
   - plan: keep a confident (`confidence >= PLAN_MIN`, 0.5) eligible plan
     that fits. Otherwise use the smallest eligible fitting plan, compared
     by CPU, then memory, then disk; probabilities do not rank the fallback.
     A confident plan `none` remains terminal (`no_fitting_plan`): Jev judged
     the workload too large for the listed sizes.
   - normalizer: a confident eligible plan that does not fit moves to the
     smallest fitting eligible plan with at least its CPU, memory and disk.
     Never shrink; if none exists, return `not_offered` `no_fitting_plan`.
     `upgraded_for_recipe` is added only when the original plan could not run
     the recipe. Docker now runs on containers, so it needs no VM upgrade.
   - console warning: game recipes (`RECIPES[id].game`) get
     `console_not_supported` when `console_player >= CONSOLE_MIN` (0.5).

All thresholds are named constants in `packages/shared/src/concierge.ts`; they
are starting values. A generic "is information missing?" question is
deliberately not asked: it fired on complete requests.

The catalogs (`USE_CASES`, `RECIPES`, warning codes, not-offered reasons,
`SUGGEST_TEXT_MAX`) live in
`packages/shared/src/concierge-catalog.ts`. It must stay zod-free: the web
imports it for labels and codes, and anything pulling in the schemas would
bundle zod into the browser.

## Defaults

| Use case                                                         | Software                                                                  | Plan when Jev is unsure                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `always_on` (apps and bots), `website`, `dev_box`, `learn_linux` | Docker                                                                    | Smallest eligible fitting plan; currently Container Small in either tier        |
| `game_server`                                                    | Most probable game, or Minecraft Java without positive game probabilities | Smallest eligible fitting plan; currently Container Small for all catalog games |
| `remote_desktop`                                                 | None (the desktop is built into its plan)                                 | Desktop Ubuntu for technical accounts; `tier_locked` for nontechnical accounts  |

A confident fitting VM choice is kept. Node.js, Python and code-server remain
in the recipe catalog for manual selection; the helper does not suggest them.
Docker is installed with the existing `docker.io` and `docker-compose-v2`
recipe inside a nested Incus container or a VM (see [recipes.md](recipes.md)).

## Environment

| variable              | default | notes                                               |
| --------------------- | ------- | --------------------------------------------------- |
| `OPENROUTER_API_KEY`  | unset   | optional; unset makes the route answer 503          |
| `CONCIERGE_DAILY_CAP` | `30`    | integer 0 to 1000; suggestions per user per UTC day |

Every provider call of one suggestion shares a single 15 s deadline
(`CONCIERGE_DEADLINE_MS`).

## Privacy and what is logged

The standalone `POST /api/concierge/suggest` endpoint does not persist request
text: not in run metadata, activity events, the ledger, error values or logs.
Agent chat reuses this decision path inside its own metered turn and retains
its guarded conversation messages and tool arguments/results; see
[agent-chat.md](agent-chat.md) for the storage boundary. Both input paths run the
shared deterministic secret scanner before model input. A detected secret
returns the fixed guard message without a provider call; chat stores only a
placeholder for that user message. Detection is best effort, not a guarantee
that arbitrary text contains no secret. The text (and its translation) is processed
by Jev and the translation model through OpenRouter and their providers; the
translation call asks OpenRouter to route only to providers that do not
collect data (`provider.data_collection: "deny"`). The alpha Jev decisions
call sends no such option (support for it there is unverified), so its
retention follows OpenRouter's and TypeSafe's own policies. Provider bodies,
error
causes and the key never reach responses or logs; the log line on a 502
carries only our code (`http_<status>`, `timeout`, `network`, `bad_response`,
`translation_incomplete`).

Each suggestion is one `agent_runs` row (`kind = concierge`,
`purpose = prod`, `succeeded` or `failed`) and one `llm_calls` row per
attempted provider call: provider `openrouter`, the reported model and request
id, token counts, latency, `cost_micro_usd = ceil(cost × 1e6)` and
`price_table_version = openrouter-usage-cost`. `prompt_hash` is the sha256 of
the exact JSON body sent; it identifies a request, it does not anonymize a
short one. A failed call still records the usage the response reported; when
no usage came back the row has `error_code = cost_unknown` and a cost of 0
that means unknown, not free.

## Cost

A Jev call is about 1,000 input and 300 output tokens and costs about
$0.00004 at 150 to 300 ms. A translated suggestion adds one chat completion
(about $0.0001, reasoning tokens included) and a second Jev call, roughly
$0.0002 in total.
