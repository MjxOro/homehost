# AGENTS.md — homehost contributor guide

Read this before touching the repo. Violations get reverted.

**Generated:** 2026-10-03T05:53:25Z
**Commit:** ff8622e
**Branch:** main

## Overview

Self-hosted VM/container hosting portal: Fastify + Effect control plane, React SPA, and a host-side Bun worker that provisions Incus instances with v6 addresses and Cloudflare DNS.

## Structure

```
homehost/
├── apps/api/          # control plane; routes in src/app.ts (OAuth in src/auth/oauth.ts), domain in src/domain, SQL in migrations/
├── apps/web/          # SPA (TanStack Router/Query, Tailwind v4)
├── apps/worker/       # provisioning loop; runs from checkout source via host systemd, NOT containerized
├── packages/shared/   # @homehost/shared cross-process contract; no build step, consumed from src
├── packages/sites/    # @homehost/sites: JSON site spec -> static site, LLM generation via OpenRouter
├── packages/bench/    # hh-bench replay-cached grading harness for sites generation (README covers it)
├── infra/             # dev/prod/traefik compose, host Incus prep, worker unit; private/ is gitignored
├── docs/              # design notes (networking, ledger, concierge, recipes, roadmap)
├── scripts/test-reset.ts  # clean-room instance/request/DNS wipe
└── .github/workflows/ # ci.yml (typecheck+unit, integration on pg service, gitleaks, web image), deploy.yml
```

Child guides: `apps/api/AGENTS.md`, `apps/web/AGENTS.md`, `apps/worker/AGENTS.md`, `packages/shared/AGENTS.md`, `packages/sites/AGENTS.md`, `infra/AGENTS.md`.

## Where to look

| Task | Location | Notes |
|------|----------|-------|
| Add/change an API route | `apps/api/src/app.ts` | errors mapped only in `send*Error` helpers |
| Domain logic / DB access | `apps/api/src/domain`, `apps/api/src/db/schema.ts` | Effect services, Drizzle tables |
| Schema change | `apps/api/migrations/` | runner `apps/api/src/db/migrate.ts` |
| Shared API types / plans | `packages/shared/src/control-plane.ts`, `plans.ts` | contract for api + web + worker |
| Web data fetching | `apps/web/src/lib/api.ts`, `lib/query.ts` | entry `src/main.tsx` -> `router.tsx` |
| Provisioning behaviour | `apps/worker/src/index.ts` | prod unit `infra/worker/homehost-worker.service` |
| Site generation | `packages/sites/src/index.ts`, `cli.ts` | graded by `packages/bench/src/cli.ts` |
| Ports / compose stacks | `infra/` | |

## Code map

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `PLANS` / `Plan` | const/type | packages/shared/src/plans.ts | ~30 | plan catalog; ids are persisted |
| `ServerRequest`, `DashboardResponse`, `PortalUser` | types | packages/shared/src/control-plane.ts | many | API contract |
| `containsSecret` | fn | packages/shared/src/secrets.ts | ~20 | secret guard for user/LLM text |
| `buildApp` | fn | apps/api/src/app.ts | server + every integration suite | app factory |
| `DatabaseTag` / `DatabaseLive` | Effect service | apps/api/src/domain/Database.ts | Effect-based domain modules | DB dependency |
| `DomainError` | tagged union | apps/api/src/domain/errors.ts | domain + app.ts | error contract |
| `queryKeys` / `queryClient` / `useSession` | TanStack Query | apps/web/src/lib/query.ts | most routes | server state |
| `api` / `ApiError` | method object / class | apps/web/src/lib/api.ts | all web data code | fetch wrapper |
| `leaseJob` / `handle` | fn | apps/worker/src/index.ts | main loop | job execution |
| `renderSite` / `validateSpec` / `generateSite` | fn | packages/sites/src/index.ts | bench + tests | sites pipeline |

## Stack

- Runtime `bun`, language TypeScript, auth GitHub OAuth, DB Postgres 17, edge Traefik, containers Incus.
- Packages: `apps/api` (Fastify control plane), `apps/web` (React + Vite + Tailwind), `apps/worker` (Bun, runs as systemd unit on the host), `packages/shared` (`@homehost/shared`), `packages/sites`, `packages/bench`.
- `tsconfig.base.json` is `strict` everywhere; only `apps/web` adds `noUncheckedIndexedAccess`.
- No new dependencies without asking. Tailwind only for styling.

## Commands (repo root)
- `bun run dev` — host-side dev loop (api `:3000` + web `:5173`, needs `db:up` + `.env`).
- `bun run dev:up / dev:down / dev:logs / dev:reset` — containerized dev stack (pg `:55433`, api `:3001`, web `:5174`). Needs `bun install`, `.env.dev` (copy `.env.dev.example`), and the edge network (comes with Traefik).
- `bun run typecheck` — MUST be 0 errors before every commit and merge.
- `bun test` (root script) — unit tests for shared, sites, bench (`bun test packages/shared` for shared only). `bun run test:integration` — needs live DB (`TEST_DATABASE_URL`); forces `SHOWCASE_MODE=true` (suites log in via `/api/demo/session`), one `test_<uuid>` schema per suite.
- `bun run build` — api (`tsc`) + web (`vite build`) only; shared/sites/bench are source-consumed.
- `bun run db:migrate` — ledger-tracked, advisory-locked, safe to re-run.
- Also: `dev:check`, `dev:migrate`, `host:check`, `host:setup`, `prod:build|up|down|logs|deploy`, `worker`, `bench`, `test:reset`, `format`, `format:check`.

## Live vs showcase

- Prod is live mode (`SHOWCASE_MODE=false`). NEVER ship showcase copy, personas, or demo sessions in live paths.
- `/api/demo/session` 404s in live. Signed-out landing stays chromeless by design.

## Networking (V6-only)

- Hosts get a stable IPv6 from `IPV6_PREFIX` + Cloudflare AAAA. `ssh root@<sub>...:22` — no `-p`, no ProxyCommand, no NAT, no Traefik TCP routes.
- Container v6 is configured in-guest (netplan); `incus config device override eth0 ipv6.address` is rejected by the bridge — don't try.
- Keep the `ssh_port` DB column. Never surface ports in UI, types, or API responses.

## Workflow

- One branch per change, cut from `main`. Micro-commits, one logical change each, imperative subject (`admin: ...`, `web: ...`, `infra: ...`).
- Before push: `typecheck` 0, `build` green, relevant tests pass, secret scan clean (`gitleaks detect --source . --log-opts='main...HEAD'`; one-time install to `~/.local/bin` from the gitleaks releases). Merge with `--ff-only`, push, delete the branch.
- Never commit `.env`, `.env.dev`, `infra/private/`, live creds, or anything under `dist/` / `node_modules/` (all gitignored). Untracked (`??`) files are never swept in bulk — `git add` named paths only, and every `??` gets an explicit track-or-ignore decision before commit.
- Never rewrite public history (`main`). Reflog-expiring purges only for secret removal, coordinated explicitly.

## Code conventions

- Fix source, never suppress symptoms. Clean cutover: migrate every caller, delete dead code, no shims or aliases.
- Reuse existing patterns; a second convention beside an existing one is a bug.
- Desktop `lg:` layout unchanged when doing mobile passes. Touch targets ≥ 44px. Keep `:focus-visible` rings. Respect `prefers-reduced-motion`.
- Web: `noUncheckedIndexedAccess` is on — index access returns `T | undefined`, handle it. Unknown enum-ish values (e.g. account status) render a neutral fallback, never crash.
- Hooks before early returns. `translate` (not `transform`) for drawer motion.
- Import suffixes follow the package: `packages/shared` uses `.js` relative imports, sites/bench are extensionless.

## Database

- Changes go in `apps/api/migrations/NNNN_name.sql`, applied in order by `migrate.ts`. Seeds live inside the migration so they insert once.
- `users.account_status`: `pending | approved | rejected | suspended` (default `pending`). `technical_level`: `technical | non_technical` (nullable).
- `moderation_actions` is the audit trail — every approve/reject/classify writes one row.
- Non-approved users get `403 { code: 'AccountPending' }` on provisioning writes. Operator = `OPERATOR_EMAILS`.

## Security guardrails

- Secrets only in environment or `infra/private/` (never tracked). OAuth/CF tokens stay server-side; the browser never sees them.
- GitHub scanner alerts on fixture literals: test passwords are `randomUUID()` per run, never string literals.
- Passwords: `randomBytes(18).base64url`, one-read `credentials`, then `CONSUMED`. Shred temp keys. `IncusError` redacts.
- Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`. No auth state in `localStorage`.
- Containers: `PermitRootLogin` + one-time password or request-time pubkey only; keys `600`.
- Multi-agent work: disjoint file ownership per agent, contracts up front (shared types in `@homehost/shared`), orchestrator runs gates — workers skip them.

## Notes

- DB ports (all loopback): `55432` retired showcase/host-dev (`db:up`), `55433` dev, `55434` prod. Never point repo `.env` or the worker unit at the prod DB from the dev loop, or vice versa.
- `prod:deploy` does NOT restart the worker. After changing `apps/worker` or `packages/shared`: `bun install --frozen-lockfile` then `systemctl restart homehost-worker`.
