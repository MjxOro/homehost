# Homehost delivery plan

## Product and architecture

A self-service control panel for friends first, with a public portfolio deployment of the same code. TypeScript end to end: React + Vite + TanStack Router/Query + Tailwind CSS, Fastify + Effect + Zod, Drizzle + Postgres. Bun is the local runtime/package manager. Effect owns typed domain workflows and service boundaries while Fastify remains the HTTP adapter. No Next.js server or second backend is needed for the authenticated dashboard. Defer Redis/BullMQ until real provisioning needs background jobs.

Keep one mainline, not a public-example fork and private-production fork. Showcase and production run separate databases, identities, domains and credentials. Publish source and sanitized environment examples; keep actual deployment configuration and secrets outside git. A public demo must never have credentials or network reachability to the homelab management network. Licensing/public repository creation requires the owner's choice; neither is performed by this build.

## Milestone 1: testable request control plane (current)

- Responsive React dashboard: catalog, request form, quota usage, request history and activity.
- Operator approval/rejection queue, tenant-scoped cancellation.
- Postgres stores users, sessions, requests and audit events. Serialize quota admission per owner in transactions; pending and approved reservations consume quota, rejected/deleted reservations release it.
- Server-derived identity, trust and role. Never accept owner IDs, trust flags or roles in a create request.
- Effect services model request admission, cancellation and operator decisions with closed typed failures; database transactions remain the source of concurrency guarantees.
- Showcase-only persona sessions explicitly opt-in, loopback binding by default, refusal to boot with production environment. Demo identities are not authentication suitable for hosting customers.
- Honest lifecycle: pending approval -> approved or rejected; owner cancellation -> deleted. Approved means capacity reserved, NOT a provisioned VM. No fabricated telemetry, costs, IPs or running servers.
- Verify via live HTTP, persistence across API restart, concurrent admission, tenant isolation, operator authorization, desktop/mobile browser workflows.

## Milestone 2: private friend pilot

1. Confirm homelab topology and hardware: Incus availability/version, ZFS pool and usable capacity, CPU/RAM reservation, routed IPv6 /64, chosen domain, backup target. Do not assume access or alter the host without these inputs.
2. Authentik OIDC authorization-code + PKCE login, server-side sessions, operator allowlist and invitations. Same-origin ingress, secure cookies, CSRF protection, login throttling. Provisioning privileges are never assigned by the browser.
3. Durable jobs/outbox and worker with idempotent Incus instance names, retries for classified transient errors, failure state and reconciliation. Approval enqueues work atomically. Database state does not prove provider state.
4. Incus projects/profiles per tenant, restricted networks, image allowlist, CPU/memory limits, ZFS quota/refquota. Untrusted users: one small workload, manual approval and expiry; Docker inside a tenant VM, never a host Docker socket.
5. Cloudflare DNS plus Traefik DNS-01 for the panel edge; flat server-owner labels with one AAAA per box published at provision and removed at teardown. Boxes are reached directly with `ssh root@<subdomain>` over IPv6, with no extra ports and no per-server Traefik routes. No Tailscale dependency for customer access.
6. Backup/restore drill, provider reconciliation after crashes, rollback/runbook, encrypted secret storage, management-network isolation, global physical capacity reservations and operator emergency suspend.

Exit gate: one friend can request an approved VM, receive its subdomain, reach it with `ssh root@<subdomain>`, stop/delete it, and have capacity reclaimed safely across worker/API restarts. Verify real ZFS enforcement, egress isolation and restore before inviting more users.

## Milestone 3: games and abuse controls

- Pterodactyl API integration for game instances; allocate game addresses transactionally and release only after provider teardown. SRV records only for supported games and public ingress.
- Expiry reminders, idle policy with explicit rules, suspend then cull grace period; transparent event history.
- Operator trust promotion, invitations/rate limits, resource ceilings and a capacity dashboard. No arbitrary public signup before abuse controls.

## Milestone 4: paid access (deferred)

Payments, subscriptions, legal/terms and support policy only after reliable friend hosting. Stripe webhooks must be signed and idempotent, entitlement state server-owned. Do not add billing stubs to the current app.

## Orchestration

The orchestrator owns architecture, shared API contracts, integration, review and final runtime/browser verification. Existing Herdr agents own disjoint backend and frontend slices; no concurrent edits to the same files, no commits or project-wide validation by workers. Work against the contract in `packages/shared/src/control-plane.ts`; the orchestrator owns root tooling, documentation and infrastructure compose. Each worker reports touched files, actual behavior and remaining risks.
