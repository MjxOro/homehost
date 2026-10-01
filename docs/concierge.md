# Concierge

`POST /api/concierge/suggest` turns a free-text wish ("vanilla minecraft for me
and 4 friends") into a suggested use case, plan and first-boot recipe. It
creates nothing: the client shows a confirm card and then calls the existing
`POST /api/requests`, which enforces tiers and quotas on its own. Recipes are
only suggested; nothing installs them yet. A refusal is advice, not
enforcement: nothing stops a user from creating a plain request directly.

## Request

Approved users (and operators) only. Body (`SuggestBody` in
`@homehost/shared`, strict: unknown keys are a 400):

```json
{
  "text": "vanilla minecraft for me and 4 friends",
  "picks": {
    "useCase": "game_server",
    "planId": "container-small",
    "recipeId": "minecraft_java"
  }
}
```

`text` is trimmed, 1 to 500 characters. `picks` is optional and answers an
earlier `choose`: the endpoint is stateless, so the client re-sends the text
plus every pick so far. Picks are catalog ids and override Jev; a picked plan
is never rewritten. A plan the user cannot create, or a picked recipe that
cannot run on the picked plan, is a 400.

## Response

A `Suggestion`, a union on `outcome`, always carrying `warnings`,
`translated`, `model` (the versioned id Jev reported), `schemaVersion` (`1`)
and `rulesVersion` (`CONCIERGE_RULES_VERSION`, bumped whenever rules,
questions or catalogs change):

| outcome       | fields                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `suggested`   | `useCase`, `planId`, `recipeId`: a complete configuration the user can create                                                         |
| `choose`      | `choice: { slot: "use_case" \| "plan" \| "recipe", options }` (1 to 3 distinct catalog ids); other fields are what is resolved so far |
| `not_offered` | `reason`: `unsupported_use_case`, `no_fitting_plan` or `tier_locked`; no plan or recipe                                               |
| `refused`     | `reason: "policy"`; no use case, plan or recipe                                                                                       |

Warning codes (the UI owns the copy): `needs_review` (abuse score in the grey
zone, or scraping), `upgraded_for_recipe` (the final plan was enlarged to a VM
because the final recipe needs one), `players_need_ipv6` (other people will
connect and boxes are IPv6-only), `console_not_supported` (console players
cannot join a self-hosted game server).

Errors use the usual `{ error, code }` shape:

| status | code                    | when                                                                |
| ------ | ----------------------- | ------------------------------------------------------------------- |
| 400    | `invalid`               | body fails `SuggestBody`, or picks the user cannot use              |
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
   now), and the probabilities `wants_gui`, `players_connect`,
   `console_player`, `abuse`, `scraping`, `is_english`. Questions live in
   `apps/api/src/domain/concierge.ts`.
3. Translation fallback, at most once: when the text is not English
   (`is_english < ENGLISH_MIN`, 0.5) and a slot still needed is unsure, the
   text is translated with `deepseek/deepseek-v4.1-flash` and Jev is asked
   again. Never for a request the original pass already refused. `abuse` and
   `scraping` keep the higher value of the two passes. A translation that is
   empty or cut off (`finish_reason` other than `stop`) fails the request.
4. `decideSuggestion` (pure, `packages/shared/src/concierge.ts`):
   - policy: `abuse >= ABUSE_REFUSE` (0.8) refuses; `abuse >= ABUSE_REVIEW`
     (0.4) or `scraping >= SCRAPING_REVIEW` (0.5) adds `needs_review`.
     Scraping never refuses.
   - use case below `USE_CASE_MIN` (0.5) asks (`choose` `use_case`); only a
     confident `not_offered` is terminal.
   - plan below `PLAN_MIN` (0.5) or recipe below `RECIPE_MIN` (0.5) are
     unresolved; only a confident plan `none` is terminal (`no_fitting_plan`).
   - eligibility: only available plans the tier may create
     (`eligiblePlans`); `desktop-omarchy` is unavailable. A remote desktop
     needs a desktop plan; a headless workload (`wants_gui < GUI_MIN`, 0.5)
     never gets one. When no eligible plan fits the workload and recipe but a
     tier-locked one would, the outcome is `not_offered` `tier_locked`.
   - one normalizer, after resolution: a model-chosen plan that does not fit
     the workload or the recipe moves to the smallest fitting eligible plan
     that is at least as large (never smaller); if none exists the user is
     asked. `upgraded_for_recipe` only when the final pair needed the VM.
   - follow-ups: plan first, then recipe; one `choose` per response. A plan
     slot with a single eligible candidate is filled without asking. Recipe
     options only include setups some eligible plan (or the picked plan) can
     run.
   - connection warnings: game recipes (`RECIPES[id].game`) always get
     `players_need_ipv6`, other recipes when `players_connect >= PLAYERS_MIN`
     (0.6); game recipes get `console_not_supported` when
     `console_player >= CONSOLE_MIN` (0.5).

All thresholds are named constants in `packages/shared/src/concierge.ts`; they
are starting values. A generic "is information missing?" question is
deliberately not asked: it fired on complete requests.

## Environment

| variable              | default | notes                                               |
| --------------------- | ------- | --------------------------------------------------- |
| `OPENROUTER_API_KEY`  | unset   | optional; unset makes the route answer 503          |
| `CONCIERGE_DAILY_CAP` | `30`    | integer 0 to 1000; suggestions per user per UTC day |

Every provider call of one suggestion shares a single 15 s deadline
(`CONCIERGE_DEADLINE_MS`).

## Privacy and what is logged

homehost does not persist request text: not in run metadata, activity events,
the ledger, error values or logs. The text (and its translation) is processed
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
