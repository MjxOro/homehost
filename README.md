# Homehost

[![ci](https://github.com/MjxOro/homehost/actions/workflows/ci.yml/badge.svg)](https://github.com/MjxOro/homehost/actions/workflows/ci.yml) · live at [homehost.risktozero.sh](https://homehost.risktozero.sh)

**Current release: a working local request-and-approval showcase, not a VM host.** Requests, sessions, quota reservations and activity are persisted in Postgres. Approval reserves capacity; it does not create infrastructure. No payments, fake running instances or invented metrics.

## Try it locally

Requires Bun 1.4+ and Docker with Compose. Bun runs the toolchain; a separate recent Node installation is not needed.

```bash
bun install
cp .env.example .env
bun run db:up
bun run db:migrate
bun run dev
```

Open **http://127.0.0.1:5173**. Use that exact origin, not `localhost`, unless you also change `APP_ORIGIN`.

API: `http://127.0.0.1:3000/api/health`. Postgres: `127.0.0.1:55432` (throwaway local credentials in `.env.example`). Both bind to loopback. `bun run db:down` stops Postgres without deleting the named data volume. Restarting the API preserves sessions and reservations.

### Walk through the product

1. Choose **Alice Chen** (untrusted): request a Game Small workload. Pending approval consumes her one-server quota.
2. Switch to **Lab Operator**: open Approvals and approve or reject it, optionally recording a reason.
3. Return to Alice: see the decision and activity. **Approved is not provisioned.** Cancel the request to release its reservation.
4. Choose **Bob Martin** (trusted): larger plans are available. Total CPU/RAM/disk quotas apply across plans, not just a server count.

Persona switching is an explicit showcase feature. Anyone using this demo can select the operator. It is **not production authentication** and must never have access to real infrastructure or customer data.

## Architecture and roadmap

- `apps/web` — React control panel, Tailwind CSS design tokens and utilities, code-defined TanStack routes, shared API types, Query caching.
- `apps/api` — Fastify HTTP adapter with Effect-powered request workflows, server-owned sessions/roles/tiers, tenant-scoped transactional quotas, approval queue and audit events.
- `packages/shared` — plan catalog and shared contracts.
- `infra/compose.yml` — isolated local Postgres service.
- `docs/roadmap.md` — staged production plan and acceptance gates.
- `docs/networking.md` — v6-only box access (`ssh root@<subdomain>`) and the Traefik panel edge; not configured by this demo.

One mainline serves the portfolio example and eventual private installation. Keep deployment secrets, actual host addresses and customer records outside the repository. Use separate databases and networks for demo and production; do not maintain a drifting example fork.

The next production gate is **Authentik OIDC + invitations**, then **Incus projects/profiles + ZFS enforcement and a durable provisioning worker**. Games use Pterodactyl afterward. Payments remain deferred. Real provisioning needs your host/network/storage details and is deliberately not faked here.

## Safety boundaries

- API startup requires `SHOWCASE_MODE=true` and `DATABASE_URL`; `NODE_ENV=production` refuses to run showcase identity switching.
- Browser mutations allow only `APP_ORIGIN` and the configured direct API origin, with JSON body validation. No permissive CORS or trusted proxy headers.
- Random session tokens are HttpOnly/SameSite cookies; Postgres stores their hashes. Rotation/logout invalidate the old token.
- The browser cannot provide owner, trust or role fields. Member reads/deletes are owner-scoped, including the operator's personal dashboard.
- Pending/approved requests reserve capacity. Admission serializes on the owner row; decisions and cancellation are locked, transactional state transitions with audit events.
- Migration files apply once under a database advisory lock with a transactional filename ledger. Add new migrations rather than editing previously applied files.
- `.env*` (except `.env.example`) and `infra/private/` are ignored. No Cloudflare, Incus or Pterodactyl credentials are needed by this release.

This is not yet hardened for an unrestricted public demo: shared personas, unbounded request history and session creation need isolation/reset/rate-limit policies before internet exposure. For now showcase it locally or with a recording. See the roadmap before enabling real hosting.

## Development checks

```bash
bun run typecheck
bun run test
TEST_DATABASE_URL=postgres://homehost:homehost@127.0.0.1:55432/homehost bun run test:integration
bun run build
bun run format:check
```

Integration tests use a uniquely named temporary Postgres schema and drop only that schema afterward. They require the local `.env` showcase configuration, and are skipped when `TEST_DATABASE_URL` is absent. The coverage targets concurrency, tenant authority, retained cancellation history, and competing approval decisions.

## Environments and continuous deployment

Three stacks, three port sets, no overlap:

| Stack | Postgres | API | Web | Command |
|---|---|---|---|---|
| Prod (live traffic) | internal only | internal `:3000` | `127.0.0.1:5180` | `bun run prod:up` |
| Dev (containers) | `127.0.0.1:55433` | `127.0.0.1:3001` | `127.0.0.1:5174` | `bun run dev:up` |
| Host (legacy manual) | `127.0.0.1:55432` | `127.0.0.1:3000` | `127.0.0.1:5173` | `bun run dev` |

Dev loop: `bun install`, `cp .env.dev.example .env.dev`, fill GitHub OAuth + `OPERATOR_EMAILS`, add the matching callback URL to the OAuth app (see `.env.dev.example` for local vs public origin), then `bun run dev:up`. Requires the edge network (`docker network create homehost-edge_default` if Traefik never ran here). `dev:logs` follows, `dev:reset` wipes the dev database.

Prod: built images tagged by git SHA (`TAG=$(git rev-parse --short HEAD)`). Secrets live in `infra/private/prod.env` (gitignored): `GITHUB_CLIENT_ID/SECRET`, `OPERATOR_EMAILS`, `APP_ORIGIN=https://homehost.risktozero.sh`, `BASE_DOMAIN=homehost.risktozero.sh`, `IPV6_PREFIX`. `bun run prod:build && bun run prod:up` (`--wait` on the api healthcheck, so a bad image fails loud instead of 502ing). Caddy serves the static web app and reverse-proxies `/api` to the api container, so cookies stay first-party. Cutover: point `infra/traefik/routes/panel.yml` at `http://host.docker.internal:5180`.

Public dev (`https://hhfrontdev…`, `https://hhbackdev…`) is intentional and unauthenticated at the edge — treat the dev stack as public: no real user data, dev-only OAuth creds where possible. CI (`.github/workflows/ci.yml`) runs on every push: typecheck, shared tests, integration tests against a Postgres service, web build, both image builds. CD (`deploy.yml`) runs `bun run prod:deploy` (checkout main → pull → build → migrate → up) on push to `main`, and needs one self-hosted runner on the prod host:

```bash
# on the prod host, as the deploy user, in /opt/homehost-runner
curl -o actions-runner.tar.gz -L <runner-tarball-from-repo-settings>
tar xzf actions-runner.tar.gz && ./config.sh --url https://github.com/<org>/homehost --token <token> --labels homehost-prod --unattended
sudo ./svc.sh install && sudo ./svc.sh start
```
