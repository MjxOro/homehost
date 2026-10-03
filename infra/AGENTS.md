# infra

## OVERVIEW
Compose stacks, host prep scripts and systemd units for dev, prod and the edge. Earned its file: distinct ops domain whose gotchas silently break tenants.

## STRUCTURE
```
infra/
├── compose.yml        # legacy host-dev Postgres (127.0.0.1:55432) for `db:up`
├── dev/               # containerized dev stack: pg :55433, api :3001, web :5174, worker (host network)
├── prod/              # prod stack: pg 127.0.0.1:55434, homehost-api/web images tagged by git sha, web 127.0.0.1:5180
├── traefik/           # edge: :80/:443, DNS-01 ACME, file routes in routes/
├── host/              # Incus + ZFS host setup, readiness probe, bridge-net unit/timer
├── worker/            # homehost-worker.service (prod worker, host systemd)
└── private/           # gitignored secrets: prod.env, worker.env, traefik.env
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Host readiness (read-only) | `host/check.sh` | `bun run host:check`; detects CGNAT |
| Install/init Incus | `host/setup-incus.sh`, `host/incus-preseed.yml.tpl` | idempotent; ZFS loop pool `homehost`, bridge `incusbr0` |
| Tenant bridge networking | `host/homehost-brnet.{sh,service,timer}` | re-applied periodically |
| Host procedures | `host/README.md` | DNS records, CF token, worker drop-in, FORWARD rules |
| Prod deploy | `prod/compose.yml`, `prod/api-entrypoint.sh` | `bun run prod:deploy` (pull, build with `TAG`, up) |
| Dev stack | `dev/compose.yml`, `dev/api-entrypoint.sh`, `dev/check.sh` | `bun run dev:check` |
| Edge routes | `traefik/routes/panel.yml` | HTTP only (no TCP routes, per V6-only policy) |

## GOTCHAS
- The worker unit runs from the checkout, not an image; `prod:deploy` ends with `bun run prod:worker` (`worker/restart.sh`) to restart it and confirm `worker up`. Keep that step if you touch the deploy chain.
- Worker prod env comes from `infra/private/worker.env` via drop-in `/etc/systemd/system/homehost-worker.service.d/env.conf`; the repo `.env` is the host dev loop and must never point at prod.
- DB ports: 55432 = retired showcase/host-dev, 55433 = dev, 55434 = prod. Everything binds 127.0.0.1.
- Docker sets FORWARD policy DROP, killing tenant egress; `iptables -I FORWARD -i/-o incusbr0 -j ACCEPT` + `netfilter-persistent save` after Docker restarts.
- Tenant bridges have no IPv6 route for egress: guest installs force IPv4 (`Acquire::ForceIPv4`) in cloud-init.
- Dev worker uses `network_mode: host` because Docker bridge has no IPv6 for readiness checks.
- Dev web binds `${DEV_BIND_IP:-127.0.0.1}`; never publish dev on a public name.

## ANTI-PATTERNS
- Adding secrets to any tracked compose/unit file; use `infra/private/*.env`.
- Exposing Postgres on a non-loopback address.
- Treating the ZFS loop pool as production storage (pilot-grade; use a dedicated disk).
