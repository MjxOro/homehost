# homehost

Self-service VM/game-server portal for the homelab. Friends get quota-bound
servers under a Cloudflare wildcard; no per-user DNS, no Tailscale.

## Layout

- `apps/api` — Fastify + Zod control plane (plans, quota checks, port pool).
- `packages/shared` — plan catalog, subdomain + port allocation (pure, tested).
- `infra/traefik` — wildcard TLS + routing to tenant workloads.
- `docs/networking.md` — DNS/ingress runbook.

## Run

```bash
bun install
bun test packages/shared
bun run dev:api   # :3000 — GET /health, /plans, /servers
```

`BASE_DOMAIN` and `PORT` envs override defaults.
