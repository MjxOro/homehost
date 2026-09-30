# Networking (v6-only boxes, Traefik panel edge)

Every box gets a stable IPv6 address inside the routed /64 (`IPV6_PREFIX`)
and its own AAAA record, published at provision and removed at teardown.
Reach any box directly with `ssh root@<subdomain>` over IPv6: default port
22 with no extra flags or client config.

The current showcase only reserves names under `lab.example.test`: it does
not publish DNS or provision instances. The production worker publishes each
box's AAAA, installs the requester's SSH key for root, and derives the
address deterministically from the request ID so relaunches converge.

Panel edge: Traefik serves the panel hostname with Let's Encrypt DNS-01
(`CF_DNS_API_TOKEN`, `ACME_EMAIL` in `infra/private/traefik.env`, never
committed; see `infra/traefik/compose.yml`). `infra/traefik/routes/panel.yml`
is the only hand-checked route file. The worker never writes
per-server SSH route files: boxes are reached directly over IPv6, never
proxied through Traefik. Desktop GUI VMs are the single exception (see
below): the worker owns per-desktop `gui-<instanceName>.yml` files only.

Keep names flat (`<server>-<owner>-<id>.lab...`) so one Let's Encrypt
certificate for `*.lab.yourdomain.com` covers them. Cloudflare Universal SSL
does **not** cover those deeper names on a normal `yourdomain.com` zone, and
is not used at all for DNS-only traffic. Traefik must serve its own certificate.

Certs: Traefik ACME DNS-01 via `CF_DNS_API_TOKEN` (template: Edit zone DNS,
scoped to the zone). See `infra/traefik/compose.yml`.

IPv4 CGNAT/port filtering affects only the v4 panel edge, never box SSH:
compare router WAN IPv4 with the public address to diagnose panel
reachability, but boxes only need the routed /64. No VPS is required for
the localhost showcase.

The existing Traefik compose is a deployment starting point, **not launched**
by the showcase. Its Docker provider/socket is not the tenant isolation model:
never attach the host Docker socket to tenant workloads.

## Abuse attribution

`ip_assignments` records each public address, routed prefix, request/user IDs,
hostname, owner name/email at assignment time, and assignment/release timestamps.
The worker opens history atomically with `server_requests.ipv6`, preserves the
first snapshot on provision retries, and closes it as soon as teardown confirms
the instance is gone (an Incus "not found" counts as gone), before DNS and route
cleanup, never on stop. IDs have no foreign keys: deleting or
truncating live requests/users cannot erase or block this historical record.
Lookups LEFT JOIN live rows, retaining snapshot attribution if those rows vanish.
Keep history indefinitely for now; the owner will decide a retention period later.

Authenticated operators can call
`GET /api/admin/ip-lookup?address=2001%3Adb8%3A%3Aa&at=2026-10-02T14%3A03%3A00Z`.
The optional `at` is ISO 8601 (UTC or explicit offset). Windows include assignment
and exclude release: `assigned_at <= at < released_at`. Without `at`, results
contain the open assignment first, followed by up to 20 most recent closed ones.
Postgres normalizes equivalent IPv6 spellings, including IPv4-mapped IPv6;
plain IPv4 is a distinct address from its mapped IPv6 form. Invalid addresses or
network masks return 400; non-operators get 403. Dates in responses are UTC ISO.

Legacy backfill is approximate: earliest recorded `running` event, falling back
to request creation, clamped to `updated_at`; deleted requests close at
`updated_at`. New assignments use the actual worker write/teardown time.
Only well-formed IPv6 text (`^[0-9a-fA-F:]+$`) is backfilled.

Deploy order matters because the API migration and the host worker unit ship
separately: merge, then deploy (applies `0013_ip_assignments.sql`), then restart
the worker unit. A worker started before 0013 fails on `ip_assignments`. On
every start the worker runs a reconcile that inserts an open assignment for
each live request with an `ipv6` but none open (boxes an old worker provisioned
between the migration and its restart), and logs how many rows it inserted.

## Desktop GUI exception (per-desktop HTTPS via Traefik) + worker topology
SSH stays direct-v6 (above). Desktop hostnames resolve via wildcard DNS
(`*.dev.<base>` + `*.homehost.risktozero.sh` A/AAAA at the edge host — no
per-VM desktop record). Traefik serves each `<label>-vnc.<base>` with the
same LE wildcard DNS-01 cert (flat names stay one level).
`infra/traefik/routes/panel.yml` stays checked in; the worker owns
per-desktop `infra/traefik/routes/gui-<instanceName>.yml` (written at
provision, removed at teardown; dev VMs mint `dev-req-*` instances so
their files/routers are `gui-dev-req-*`). Traefik proxies to KasmVNC over
HTTPS with `insecureSkipVerify` (KasmVNC self-signed backend cert).
Stopped desktop = Traefik 502; rows keep showing the real VM state.
Full runbook: `docs/desktop-gui.md`.

Worker placement (2026-09-18): the dev worker (compose, `WORKER_ENV=dev`,
`WORKER_BASE_DOMAIN=dev.homehost.risktozero.sh`) leases only `*.dev` rows
in the dev DB (`127.0.0.1:55433`, volume `homehost-dev-postgres`) and puts
VMs in `tenant-dev-*` projects; the host systemd worker
(`WORKER_ENV=prod`, apex filter) owns prod rows in the prod DB
(`127.0.0.1:55434`, volume `homehost-prod-postgres`) under legacy
`tenant-*` projects. Pre-split dev VMs (legacy names) stay put and keep
working; only new dev rows take the `dev-req-*` shape. The retired
showcase DB (`55432`, no listener) must never be a worker target.
