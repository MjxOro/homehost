# Networking (Cloudflare wildcard, no per-user DNS)

One-time manual DNS (Cloudflare Free, DNS-only grey cloud):

```dns
A  lab.yourdomain.com    <PUBLIC-IP>
A  *.lab.yourdomain.com  <PUBLIC-IP>
```

That single wildcard record covers flat tenant hostnames. The current showcase
only reserves names under `lab.example.test`: it does not create DNS, routes,
ports or instances. The production worker will write Traefik `Host()` routes
and allocate game IP/port leases after provider provisioning.

Keep names flat (`<server>-<owner>-<id>.lab...`) so one Let's Encrypt
certificate for `*.lab.yourdomain.com` covers them. Cloudflare Universal SSL
does **not** cover those deeper names on a normal `yourdomain.com` zone, and
is not used at all for DNS-only traffic. Traefik must serve its own certificate.

Certs: Traefik ACME DNS-01 via `CF_DNS_API_TOKEN` (template: Edit zone DNS,
scoped to the zone). See `infra/traefik/compose.yml`.

CGNAT check: compare router WAN IPv4 with the public address, and check whether
WAN is in `100.64.0.0/10` or RFC1918 private space. A mismatch indicates upstream
NAT but can also be a second router you control. Verify ISP inbound filtering
and actual port reachability before promising public service. Resolve with an
ISP public/static address or a later public frontend; no VPS is required for
the localhost showcase.

The existing Traefik compose is a deployment starting point, **not launched**
by the showcase. Its Docker provider/socket is not the tenant isolation model:
never attach the host Docker socket to tenant workloads, and replace discovery
with controlled file-provider routes for Incus instances during the pilot.

Reference: [Cloudflare Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).
