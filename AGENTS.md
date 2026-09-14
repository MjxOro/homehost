# AGENTS.md — homehost contributor guide

Read this before touching the repo. Violations get reverted.

## Stack

- Runtime `bun`, language TypeScript, auth GitHub OAuth, DB Postgres 17, edge Traefik, containers Incus.
- Packages: `apps/api` (Fastify control plane), `apps/web` (React + Vite + Tailwind), `apps/worker` (Bun, runs as systemd unit on the host), `packages/shared` (`@homehost/shared`).
- No new dependencies without asking. Tailwind only for styling.

## Commands (repo root)

- `bun run dev` — host-side dev loop (api `:3000` + web `:5173`, needs `db:up` + `.env`).
- `bun run dev:up / dev:down / dev:logs / dev:reset` — containerized dev stack (pg `:55433`, api `:3001`, web `:5174`). Needs `.env.dev` (copy `.env.dev.example`).
- `bun run typecheck` — MUST be 0 errors before every commit and merge.
- `bun test packages/shared` — unit tests. `bun run test:integration` — needs live DB (`TEST_DATABASE_URL`).
- `bun run build` — api (`tsc`) + web (`vite build`).
- `bun run db:migrate` — ledger-tracked, advisory-locked, safe to re-run.

## Live vs showcase

- Prod is live mode (`SHOWCASE_MODE=false`). NEVER ship showcase copy, personas, or demo sessions in live paths.
- `/api/demo/session` 404s in live. Signed-out landing stays chromeless by design.

## Networking (V6-only)

- Hosts get a stable IPv6 from `IPV6_PREFIX` + Cloudflare AAAA. `ssh root@<sub>...:22` — no `-p`, no ProxyCommand, no NAT, no Traefik TCP routes.
- Container v6 is configured in-guest (netplan); `incus config device override eth0 ipv6.address` is rejected by the bridge — don't try.
- Keep the `ssh_port` DB column. Never surface ports in UI, types, or API responses.

## Workflow

- One branch per change, cut from `main`. Micro-commits, one logical change each, imperative subject (`admin: ...`, `web: ...`, `infra: ...`).
- Before push: `typecheck` 0, `build` green, relevant tests pass. Merge with `--ff-only`, push, delete the branch.
- Never commit `.env`, `.env.dev`, `infra/private/`, or anything under `dist/` / `node_modules/` (all gitignored).
- Never rewrite public history (`main`). Reflog-expiring purges only for secret removal, coordinated explicitly.

## Code conventions

- Fix source, never suppress symptoms. Clean cutover: migrate every caller, delete dead code, no shims or aliases.
- Reuse existing patterns; a second convention beside an existing one is a bug.
- Desktop `lg:` layout unchanged when doing mobile passes. Touch targets ≥ 44px. Keep `:focus-visible` rings. Respect `prefers-reduced-motion`.
- Web: `noUncheckedIndexedAccess` is on — index access returns `T | undefined`, handle it. Unknown enum-ish values (e.g. account status) render a neutral fallback, never crash.
- Hooks before early returns. `translate` (not `transform`) for drawer motion.

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
