# Networking (Cloudflare wildcard, no per-user DNS)

One-time manual DNS (Cloudflare Free, DNS-only grey cloud):

```dns
A  lab.yourdomain.com    <PUBLIC-IP>
A  *.lab.yourdomain.com  <PUBLIC-IP>
```

That single wildcard record covers every tenant subdomain. The API never
creates DNS records; it only creates Traefik `Host()` routes + allocates a
game port from the pool. Keep names flat (`<server>-<owner>.lab...`) —
free Universal SSL covers `*.lab`, not `*.*.lab`.

Certs: Traefik ACME DNS-01 via `CF_DNS_API_TOKEN` (template: Edit zone DNS,
scoped to the zone). See `infra/traefik/compose.yml`.

CGNAT check: compare router WAN IP vs `curl ifconfig.me`. If WAN is
`100.64-127.x.x` or differs from the public IP, inbound port forwards die
at the ISP — that is the only case that needs a VPS frontend later.
