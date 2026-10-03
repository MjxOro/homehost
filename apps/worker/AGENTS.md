# apps/worker

## OVERVIEW
Host-side provisioning loop: leases `provision_jobs` from Postgres and drives Incus (launch, power, setup, desktop), Cloudflare DNS and IPv6 assignment. Earned its file: distinct runtime (host systemd, runs from source), high blast radius.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Main loop, job dispatch | `src/index.ts` (~1300 lines) | `main()` -> `leaseJob()` -> `handle(job)` switch on `job.action` |
| Incus invocation | `src/index.ts` `incus()` | `spawn` with stdin ignored, 300s timeout |
| Error redaction | `IncusError`, `redactArgs` | masks `--config`, `-c`, `-euc` argv values |
| Project / instance naming | `projectOf`, `projectForReq`, `instanceNameOf` | dev vs prod placement |
| Desktop (KasmVNC / Omarchy) | `src/desktop.ts` | `desktopPackages`, `kasmLaunchCommand`, `desktopSystemdUnit`, ... |
| Setup recipes | `src/recipes.ts` | `setupScript` shell builder |

## RUNTIME FACTS
- Started by `infra/worker/homehost-worker.service` (or `bun run worker`). Runs from this checkout's source, not an image.
- `prod:deploy` restarts it via `bun run prod:worker` (`infra/worker/restart.sh`), which fails the deploy unless `worker up` is logged within 30s. Manual: `git pull --ff-only && bun install --frozen-lockfile && bun run prod:worker`.
- Env: `DATABASE_URL`, `IPV6_PREFIX`, `CF_DNS_API_TOKEN`, `WORKER_ENV`, `WORKER_BASE_DOMAIN`. Prod values come from `infra/private/worker.env` via a systemd drop-in.
- Startup requeues every `leased` job (crash recovery) and reconciles `ip_assignments`.
- Leasing: `SELECT ... FOR UPDATE SKIP LOCKED`, status `queued -> leased`, attempts++.

## ENV SCOPING
- `WORKER_BASE_DOMAIN` set => only handle requests whose subdomain sits under it; other-env jobs are requeued (`wrong-env:`) untouched.
- Dev rows (`*.dev.homehost.risktozero.sh`) live in Incus project `tenant-dev-<owner>` with instance `dev-req-<id8>`; prod/showcase keep legacy `tenant-<owner>` / `req-<id8>`.
- Teardown/power MUST resolve the project with `projectForReq` (stored name wins), never `projectOf`, or pre-split VMs become orphans.

## CONVENTIONS
- Relaunches must be idempotent: instance names are derived from the request id.
- Uses raw `postgres` tagged SQL, not Drizzle; table/column names must match `apps/api/migrations`.
- Shared helpers (`ipv6ForInstance`, `toSubdomain`, `PLANS`, setup recipes) come from `@homehost/shared`; don't fork them here.

## ANTI-PATTERNS
- `execFile` for incus: its inherited stdin keeps `incus launch` blocked forever.
- Logging incus argv or cloud-init without `redactArgs` / `IncusError`.
- Pointing the host unit at the dev DB (`:55433`) or the retired showcase DB (`:55432`); prod is `:55434`.
- Moving existing VMs between projects by changing naming helpers.
