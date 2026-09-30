# Host setup (any machine, including this one)

Reproducible host prep for the private Homehost install. The demo needs none
of this; run it on a machine you intend to host tenants on.

```bash
bash infra/host/check.sh          # read-only probe, safe anywhere
POOL_SIZE_GB=200 sudo -E bash infra/host/setup-incus.sh
```

What `setup-incus.sh` does (idempotent, re-runnable): installs Incus +
ZFS tools on Ubuntu 24.04+, initializes the daemon from
`incus-preseed.yml.tpl` only when uninitialized (ZFS loop pool `homehost`,
bridge `incusbr0`), and adds your user to `incus-admin`. The loop pool is
pilot-grade; for real tenants replace `source` with a dedicated disk/partition
and re-run init on a fresh daemon.

Domain and Cloudflare are **not needed yet**. The LAN pilot works with IPs
and `APP_ORIGIN=http://<host-lan-ip>:5173`. When you buy the domain:

   `A homehost.<domain> -> <public-IP>`, `A *.homehost.<domain> -> <public-IP>`
   (grey cloud / DNS-only on both).
2. Token: Edit-zone-DNS scoped to that zone -> `CF_DNS_API_TOKEN` in the
   private deploy env (never committed; `.env*` is gitignored).
3. `ACME_EMAIL` for the Let's Encrypt account; Traefik DNS-01 reads both
   from the environment (see `infra/traefik/compose.yml`).
4. If `check.sh` reports CGNAT (public IP is `100.64-127.x.x` or differs
   from the router WAN IP), inbound ports die at the ISP: you need a public
   IP from the ISP or a VPS frontend before public ingress can work.

Docker sets `FORWARD` policy DROP with no Incus accept, which silently kills
tenant egress (apt, updates) even though Incus manages its own nftables NAT.
Re-apply after Docker restarts and persist with `iptables-persistent`:

```bash
sudo iptables -I FORWARD -i incusbr0 -j ACCEPT
sudo iptables -I FORWARD -o incusbr0 -j ACCEPT
sudo netfilter-persistent save
```

Tenant bridges also have no IPv6 route: guest package installs must force
IPv4 (`Acquire::ForceIPv4 "true"` in cloud-init) until the host routes v6.

## Prod worker service

`homehost-worker.service` (host systemd, `WORKER_ENV=prod`) reads its
environment from `infra/private/worker.env` (mode 600, never committed) via
the drop-in `/etc/systemd/system/homehost-worker.service.d/env.conf`, which
replaces the unit's `EnvironmentFile=.env`. The repo `.env` belongs to the
host dev loop and must never point at prod.

```ini
# infra/private/worker.env
DATABASE_URL=postgres://homehost:<password>@127.0.0.1:55434/homehost  # prod DB only
IPV6_PREFIX=<same as infra/private/prod.env>
CF_DNS_API_TOKEN=<Edit-zone-DNS token, same as infra/private/traefik.env>
```

Deploys (`prod:deploy`) don't restart this unit. After a merge that changes
`apps/worker`, run `sudo systemctl restart homehost-worker` and check
`journalctl -u homehost-worker -n 20` for `worker up (prod)`.

## Tenant IPv6 gateway

Boxes reach the internet over IPv6 only while `incusbr0` holds the /64
gateway (`<IPV6_PREFIX>::ffff/64`, see `docs/networking.md`). Incus disables
IPv6 on the bridge on every daemon start, so a checker keeps it in place:
`homehost-brnet.sh` reads `IPV6_PREFIX` from `infra/private/worker.env`,
re-enables IPv6 on the bridge and re-adds the address when missing. It runs
after every Incus start and every 30s, and logs only when it repairs
something. Install or update:

```bash
sudo install -m 0755 infra/host/homehost-brnet.sh /usr/local/sbin/homehost-brnet
sudo install -m 0644 infra/host/homehost-brnet.service infra/host/homehost-brnet.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl reenable homehost-brnet.service homehost-brnet.timer
sudo systemctl start homehost-brnet.timer homehost-brnet.service
journalctl -u homehost-brnet -n 5   # "incusbr0: restored ..." after a repair
```
