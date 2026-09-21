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
