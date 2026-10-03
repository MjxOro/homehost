# apps/api

## OVERVIEW
Fastify control plane: auth, request lifecycle, moderation, concierge/agent LLM features, ledger. Business logic is Effect-based. Earned its file: ~10k LOC, distinct layered architecture, owns migrations + integration tests.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Boot | `src/server.ts` | calls `buildApp`, signal handlers |
| HTTP routes | `src/app.ts` (~1700 lines) | `buildApp(options)`; routes registered inline as `app.get/post(...)`, except OAuth (`registerOAuth` in `src/auth/oauth.ts`) |
| Config / env vars | `src/env.ts` | `getEnv()` -> `ApiEnv`; validates paired OAuth id/secret, live-mode requirements |
| Cookies / sessions | `src/auth/cookies.ts` | `createCookiePolicy`, `SESSION_MAX_AGE_S` |
| OAuth | `src/auth/oauth.ts` | `registerOAuth` (GitHub + Google) |
| Desktop tickets | `src/auth/desktop-tickets.ts`, `src/desktop-bridge.ts` | `redactDesktopUrl` |
| Tables | `src/db/schema.ts` | Drizzle definitions; must mirror SQL migrations |
| DB client | `src/db/client.ts` | `createDb`, `Database`, `DbTransaction` |
| Migration runner | `src/db/migrate.ts` | ledger table `schema_migrations`, advisory key `721913` |
| Domain logic | `src/domain/*.ts` | users, requests (state machine), concierge, agent-chat, ledger, audit, ipAssignments |
| Domain errors | `src/domain/errors.ts` | tagged union `DomainError` |

## CONVENTIONS
- Most domain modules (`requests`, `users`, `ledger`, `concierge`, `audit`, `ipAssignments`) return `Effect<A, E, DatabaseTag>`; `app.ts` runs them via one `ManagedRuntime.make(DatabaseLive(db))`. `agent-chat.ts` is Promise-based and throws `AgentProblem`.
- Effect modules return tagged (`_tag`) errors instead of throwing. HTTP mapping is centralized: `sendDomainError`, `sendAdminError`, `sendConciergeError`, `sendErr` in `app.ts`. New error tags get a branch there.
- Request bodies are validated with Zod at the route.
- Response/request types come from `@homehost/shared`; the web app consumes the same types.
- A schema change = new `migrations/NNNN_*.sql` + matching `src/db/schema.ts` edit in the same change.
- Build emits `dist/` via `tsc`; prod runs `bun dist/server.js`.

## HOTSPOTS
- `app.ts` 1700, `domain/agent-chat.ts` ~740, `domain/requests.ts` ~710, `domain/concierge.ts` ~550.

## TESTS (`test/`)
- DB-backed suites are opt-in via `describe.skipIf(!TEST_DATABASE_URL)`; `cookies.test.ts` is pure and always runs.
- Each DB suite creates a fresh schema `test_<uuid>`, sets `search_path`, applies every `migrations/*.sql` in order, then `buildApp({ db, ... })` and drives it with `app.inject`.
- Most DB suites clean up in `afterEach`; `agent-chat`, `concierge` and `ledger` have no `afterEach`.
- Logins go through `POST /api/demo/session` (hence `SHOWCASE_MODE=true` in `test:integration`) or a fixture session minted exactly like the app (64-hex token, sha256 row).
- LLM providers are injected fakes (`buildApp({ concierge })`), never real network.
- Biggest suites: `concierge` ~830, `ip-assignments` ~640, `agent-chat` ~550.

## ANTI-PATTERNS
- Throwing from Effect-based domain code, or mapping errors to status codes outside the `send*Error` helpers.
- Editing an applied migration; add a new numbered file.
- Tests that share the default schema or demo tables.
- Logging raw desktop URLs or tokens; use `redactDesktopUrl`.
