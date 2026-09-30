# Concierge

`POST /api/concierge/suggest` turns a free-text wish ("vanilla minecraft for me
and 4 friends") into a suggested use case, plan and first-boot recipe. It
creates nothing: the client shows a confirm card and then calls the existing
`POST /api/requests`. Recipes are only suggested; nothing installs them yet.

## Request and response

Approved users (and operators) only. Body `{ "text": string }`, trimmed,
1 to 500 characters (`SuggestBody` in `@homehost/shared`).

The response is a `Suggestion` (`packages/shared/src/concierge.ts`):

| field        | notes                                                               |
| ------------ | ------------------------------------------------------------------- |
| `outcome`    | `suggested`, `choose`, `not_offered` or `refused`                   |
| `useCase`    | a `USE_CASES` id, or null when refused                              |
| `planId`     | a `PLANS` id; null unless `suggested` or a recipe `choose`          |
| `recipeId`   | a `RECIPES` id; null when not offered, refused or a recipe choose   |
| `choice`     | only for `choose`: `{ slot: "plan" \| "recipe", options }`, top 3   |
| `warnings`   | stable codes, the UI owns the copy (below)                          |
| `translated` | true when the text was translated to English before deciding        |
| `model`      | the versioned model id Jev reported, e.g. `typesafe/jev-1.13-2026…` |

Warning codes: `needs_review` (abuse score in the grey zone),
`upgraded_for_recipe` (plan bumped to a VM because the recipe needs one),
`plan_locked` (plan is technical-only and the user is not; the create endpoint
still enforces tiers), `players_need_ipv6` (other people will connect, and
boxes are IPv6-only).

Errors use the usual `{ error, code }` shape:

| status | code                    | when                                               |
| ------ | ----------------------- | -------------------------------------------------- |
| 400    | `invalid`               | body fails `SuggestBody`                           |
| 429    | `concierge_cap`         | daily cap reached                                  |
| 502    | `concierge_upstream`    | provider error, timeout (10 s) or malformed answer |
| 503    | `concierge_unavailable` | `OPENROUTER_API_KEY` unset                         |

Provider bodies and the key never reach the client or the logs; the log line
carries only our error code (`http_<status>`, `timeout`, `network`,
`bad_response`).

## How it decides

1. One request to Jev (`typesafe/jev-1.13`, OpenRouter
   `POST /api/alpha/decisions`) asks every question at once: `use_case`, `plan`,
   `recipe` (choices whose criteria come from `USE_CASES`, `PLANS` and
   `RECIPES`), and the probabilities `wants_gui`, `players_connect`, `abuse`,
   `is_english`. Questions live in `apps/api/src/domain/concierge.ts`.
2. If `is_english < ENGLISH_MIN` (0.5) and the use case confidence is below
   `TRANSLATE_USE_CASE_MIN` (0.7), the text is translated once with
   `deepseek/deepseek-v4.1-flash` and Jev is asked again on the English text.
3. `decideSuggestion` (pure, in `packages/shared/src/concierge.ts`) applies the
   rules, in order:
   - `abuse >= ABUSE_REFUSE` (0.8) refuses; `>= ABUSE_REVIEW` (0.4) continues
     with `needs_review`.
   - use case `not_offered` returns `not_offered`.
   - plan `none` with confidence `>= PLAN_MIN` returns `not_offered`.
   - plan confidence `< PLAN_MIN` (0.5) returns `choose` for the plan: top 3
     real plans by probability, minus container plans when the recipe needs a
     VM.
   - a desktop plan is swapped for the most likely headless plan unless the use
     case is `remote_desktop` or `wants_gui >= GUI_MIN` (0.5).
   - a recipe with `requiresVm` on a container plan moves to the smallest
     headless VM plan with `upgraded_for_recipe`.
   - `plan_locked` for technical-only plans and nontechnical users.
   - recipe confidence `< RECIPE_MIN` (0.5) returns `choose` for the recipe
     (top 3 by probability). Only one `choose` slot per response, plan first.
   - `players_need_ipv6` when `players_connect >= PLAYERS_MIN` (0.6).

All thresholds are named constants next to `decideSuggestion`; they are
starting values. A generic "is information missing?" question is deliberately
not asked: it fired on complete requests.

## Environment

| variable              | default | notes                                            |
| --------------------- | ------- | ------------------------------------------------ |
| `OPENROUTER_API_KEY`  | unset   | optional; unset makes the route answer 503       |
| `CONCIERGE_DAILY_CAP` | `30`    | suggestions per user per UTC day; `0` blocks all |

## What is logged

Each suggestion is one `agent_runs` row (`kind = concierge`,
`purpose = prod`, `succeeded` or `failed`) and one `llm_calls` row per provider
call, including failed ones (`status = error`, cost 0): provider `openrouter`,
the reported model and request id, token counts, latency, `cost_micro_usd` as
`ceil(cost × 1e6)` and `price_table_version = openrouter-usage-cost`.
`prompt_hash` is the sha256 of the exact JSON body sent.

The user's text is never stored: not in run metadata, not in activity events,
not in the ledger. The daily cap counts today's concierge `agent_runs` for the
user (failed ones included). The count and the insert are not serialized, so
concurrent requests can overshoot the cap by the number in flight.

## Cost

A Jev call is about 1,000 input and 300 output tokens and costs about
$0.00004 (40 to 45 micro-dollars) at 150 to 300 ms. A translated suggestion adds
one chat completion (about $0.0001, reasoning tokens included) and a second Jev
call, so roughly $0.0002 in total.
