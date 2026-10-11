# apps/worker

## OVERVIEW

Go host-side provisioning loop: leases `provision_jobs` from Postgres and drives Incus (launch, power, setup, desktop) through the native Incus API, plus Cloudflare DNS and IPv6 assignment. Earned its file: distinct runtime (host systemd binary), high blast radius.

## WHERE TO LOOK

| Task                                         | Location                                                      | Notes                                                                       |
| -------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Entry, env parsing, signals                  | `main.go`                                                     | builds `worker.Config`, connects pgx pool (max 4) + Incus socket            |
| Main loop, job dispatch                      | `internal/worker/worker.go`, `jobs.go`                        | `Run()` -> `tick()` -> `leaseJob()` -> `handle(job)` switch on `job.action` |
| SQL                                          | `internal/worker/store.go`                                    | raw pgx SQL, ids cast `::text`                                              |
| Incus calls                                  | `internal/incus/incus.go`                                     | implements `worker.Incus` (`internal/worker/ports.go`) on the unix socket   |
| Project / instance naming                    | `projectOf`, `projectForReq`, `instanceNameOf` in `worker.go` | dev vs prod placement                                                       |
| Cloud-init, container sshd, netplan          | `internal/worker/access.go`                                   |                                                                             |
| Desktop (KasmVNC / Omarchy) + Traefik routes | `internal/worker/desktop.go`                                  |                                                                             |
| Setup recipes                                | `internal/worker/recipes.go`                                  | `setupScript` text/template step scripts                                    |
| Cloudflare AAAA + DoH                        | `internal/worker/cloudflare.go`                               | `worker.DNS`; nil without `CF_DNS_API_TOKEN`                                |
| Shared catalog + ported helpers              | `internal/contract`                                           | `contract.json` + `testdata/vectors.json` are generated, never hand-edited  |

## RUNTIME FACTS

- Prod: `infra/worker/homehost-worker.service` runs `apps/worker/bin/homehost-worker` with the checkout as cwd (route files go to `infra/traefik/routes`). `bun run prod:worker` (`infra/worker/restart.sh`) builds the binary atomically, installs the unit if it changed, restarts, and fails the deploy unless `worker up` is logged within 30s.
- Dev stack: `infra/dev/compose.yml` builds `apps/worker/Dockerfile`; it mounts only the Incus socket and the routes dir. `bun run worker` runs it from source with the repo `.env`.
- Env: `DATABASE_URL`, `IPV6_PREFIX`, `CF_DNS_API_TOKEN`, `WORKER_ENV`, `WORKER_BASE_DOMAIN`, tuning `WORKER_POLL_MS`, `WORKER_*_ATTEMPTS`, `WORKER_BOOT_TIMEOUT_MS`, `WORKER_READY_TIMEOUT_MS`. A malformed number fails startup. Prod values come from `infra/private/worker.env` via a systemd drop-in.
- Startup requeues every `leased` job (crash recovery) and reconciles `ip_assignments`.
- Leasing: `SELECT ... FOR UPDATE SKIP LOCKED`, status `queued -> leased`, attempts++.
- Pickup: a dedicated pgx connection `LISTEN`s on `provision_jobs` (trigger from migration `0017`) and wakes the idle loop at once, reconnecting with backoff; `WORKER_POLL_MS` polling stays the fallback. The boot wait polls instance state every 1s.
- Images: plans name baked aliases in the `default` project (`infra/host/build-images.sh`). `Launch` copies the current build into the tenant project by fingerprint (tenant projects have `features.images`) and deletes older builds there. A missing alias wraps `worker.ErrImageMissing` and fails the job without retries.
- SIGINT/SIGTERM: the current job finishes (setup requeues between steps); jobs never run on a cancelled context.

## ENV SCOPING

- `WORKER_BASE_DOMAIN` set => only handle requests whose subdomain sits under it; other-env jobs are requeued (`wrong-env:`) untouched.
- Dev rows (`*.dev.homehost.risktozero.sh`) live in Incus project `tenant-dev-<owner>` with instance `dev-req-<id8>`; prod/showcase keep legacy `tenant-<owner>` / `req-<id8>`.
- Teardown/power MUST resolve the project with `projectForReq` (stored name wins), never `projectOf`, or pre-split VMs become orphans.

## CONVENTIONS

- Relaunches must be idempotent: instance names are derived from the request id.
- Table/column names must match `apps/api/migrations`.
- Shared rules come from `@homehost/shared` through `internal/contract`: change them in shared, run `bun run worker:contract`, commit. Helpers the worker re-implements (`Ipv6ForInstance`, `ToDesktopHostname`, `SameIpv6`, `DohHasAaaa`, `SetupErrorOf`, `IsTransientSetupFailure`, `GameAddressOf`) are pinned to the TS originals by `TestSharedHelperParity`.
- Incus errors: 404 (missing instance or project) wraps `worker.ErrNotFound`; teardown treats it as gone.
- `gofmt` clean; `bun run test:worker` before committing (set `TEST_DATABASE_URL` to run the DB suites).

## ANTI-PATTERNS

- Falling back to `images:` when a baked alias is missing, or apt-installing at first boot what every box needs (bake it into the image instead).
- Shelling out to the `incus` CLI: user-data (passwords, keys) would travel in argv and error text.
- `Exec` without a closed stdin: an open stdin lets a guest prompt block forever.
- Querying DoH (or any recursive resolver) for a box before the zone's authoritative nameservers serve its exact AAAA: until the record propagates, the name matches the `*.homehost` wildcard and the resolver caches the edge address for the wildcard's TTL, outlasting the readiness gate (`Visible` in `cloudflare.go`).
- Putting instance config or guest scripts into error messages or logs.
- Pointing the host unit at the dev DB (`:55433`) or the retired showcase DB (`:55432`); prod is `:55434`.
- Moving existing VMs between projects by changing naming helpers.
- Hand-editing `internal/contract/contract.json` or `testdata/vectors.json`.
