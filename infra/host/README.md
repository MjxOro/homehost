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
