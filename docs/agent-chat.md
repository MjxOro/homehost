# Agent chat

The dashboard setup box starts an owner-only conversation at `/chat/$id`.
The Agent sidebar lists conversations newest first and marks linked servers
that are still setting up. `/new` remains the manual request path. Chat is
available to approved accounts; operators can access only their own chats.

## API and storage

- `POST /api/agent/conversations` accepts `{ text }` and records the first
  message. A safe conversation starts pending; opening it submits its first
  turn. Repeating that initial turn after completion does not call a provider.
- `GET /api/agent/conversations` lists the owner's latest 100 conversations.
- `GET /api/agent/conversations/:id` returns the latest 200 messages and linked
  setup state. Foreign IDs return 404, including for operators.
- `POST /api/agent/conversations/:id/turns` accepts `{ text }`, or `{}` for the
  pending first turn. Text is trimmed and limited to 2,000 characters.

Migration `0016_agent_chat.sql` stores conversation ID, owner, first-message
title (up to 80 characters), created/updated times and pending/running/idle
status. Messages retain their ID, conversation, ordered sequence, role,
guarded content, tool name, guarded tool arguments/results, optional linked
request, creation time and optional deduplication key. These records support
conversation continuity, resuming setup progress and later improvement of
setup guidance. There is no automatic expiry or operator conversation viewer
in v1. Deleting an owner cascades to their conversations and messages.

The shared pure scanner checks Discord, Telegram, OpenAI/OpenRouter, GitHub,
AWS, private-key PEM and JWT shapes, plus conservative long high-entropy
strings. It runs before storing user text or sending it to a provider. A hit
stores `[Message blocked: possible password or token]` and the fixed guard response;
the original text does not enter the title, messages, tool data, run metadata
or provider request. It consumes no turn or provider call. Model text and tool
arguments/results are guarded before storage/replay too. This is best-effort
detection; the application must never ask users to paste credentials. Real
server passwords are excluded from agent tools and chat storage.

The standalone concierge endpoint still does not retain its input text. Chat
does retain its safe text and the `suggest_setup` arguments/results. Provider
bodies, error causes and API keys are never returned or logged. See
[concierge.md](concierge.md) for Jev's provider boundary: the agent and
translation chat completions request `provider.data_collection: "deny"`;
the alpha Jev decisions API does not have verified support for that option.

## Tools and the creation boundary

The server pins `deepseek/deepseek-v4.1-flash`, low reasoning, 2,000 output
tokens, nonparallel tool calls and the provider data-collection deny policy.
It exposes exactly four tools:

| Tool                                     | Behavior                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `suggest_setup(text)`                    | Reuses Jev and `decideSuggestion`, including the existing translation fallback, inside the chat run.                        |
| `propose_server(name, planId, recipeId)` | Validates name, available plan, account tier, installable/fitting recipe and current quota; writes only a proposal message. |
| `server_status(requestId)`               | Reads only a request belonging to this user, with status, setup state, address and login command.                           |
| `list_my_servers()`                      | Reads up to 20 of the user's undeleted requests with those same public fields.                                              |

No tool creates infrastructure or runs commands. The proposal card's Create
it button calls the existing `POST /api/requests`, with its proposal message
ID. That endpoint verifies ownership and the exact proposed configuration,
then repeats tier, recipe, EULA and locked quota checks. Only this user action
links the proposal to a new request. Repeated clicks return the linked request
without creating another one. Minecraft requires the existing EULA checkbox.

Progress comes from request/activity data, using the same timeline and ready
details as the server progress page. Polling is 2.5 seconds while active and
10 seconds while idle. A unique readiness key records one fixed assistant
notice per linked request without a provider call. A process-interrupted
turn older than 75 seconds is marked failed on read, with an invitation to
retry; its provider calls are never replayed automatically.

## Metering and limits

Each admitted turn is one `agent_runs` row with kind `agent_chat`, purpose
`prod` and reference to the conversation. Each attempted provider call,
including Jev/translation calls, gets an `llm_calls` row under that same run:
reported model/request ID, token/cache counts, latency, prompt SHA-256 and
`cost_micro_usd = ceil(reported cost * 1e6)`. Missing usage is recorded as
`cost_unknown` with zero cost, which means unknown rather than free.

`AGENT_CHAT_DAILY_TURNS` defaults to 40 per user per UTC day (integer 0–1000).
Admission locks the user row and counts runs in every status, so concurrent
requests cannot exceed the cap. A conversation permits one running turn.
Each turn shares a 60-second provider deadline and can execute at most six
tool steps; after that the model gets a final call with tools disabled. The
model sees the latest 20 stored messages; historical tool results are bounded
summaries, and current-turn tool replies use the normal tool-call protocol.

Without `OPENROUTER_API_KEY`, chat writes answer 503 `agent_unavailable`.
Existing conversations remain readable and the dashboard uses the existing
inline helper flow. Daily caps return 429 `agent_cap`; a concurrent turn in
the same conversation returns 409 `agent_busy`. Failures produce short fixed
copy, with no stack traces or provider error text.

## Try on dev

Apply migrations to the dev database, then open `http://192.168.1.16:5174`.
Sign in as Bob through the showcase persona selector (Alice already has her
one allowed server). Submit “a discord bot for my server”, inspect the
Container Small / Docker card, click Create it, and approve the resulting
request as the operator through `POST /api/requests/:id/decision` with
`{ decision: "approve" }`. Leave the chat open through Docker setup and the
ready notice. Generated fake token input should show the guard immediately,
retain only its placeholder and add no ledger call.

The dev smoke exposed a worker DNS retry bug when Cloudflare canonicalizes
IPv6 groups with leading zeroes. The worker now uses the existing shared
IPv6 comparison helper to recognize that the record already exists.

Installing the user's bot/app, secrets entry, service manifests, website
builder steps, resizing an existing server and an operator conversation
viewer are outside v1. The helper explains what is coming soon and what the
user can do now; a larger setup can be proposed as a new server.
