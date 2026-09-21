# GUI desktops on Homehost — operator runbook

Browser-native desktops (KasmVNC canvas, zero client installs). Request
Ubuntu-XFCE or Omarchy from the panel, then open it from your dashboard —
the panel serves a same-origin proxied canvas URL and injects the persistent
`desktop_password` toward the guest (never leaves the server), so the canvas
autoconnects with no login form.

## Naming

- SSH (direct v6): `<subdomain>` = `<server>-<owner>-<requestid>.<base>`
  (existing `toSubdomain`, flat, one DNS level).
- Desktop (via Traefik): `<label>-vnc` where `<label>` is the SSH leftmost
  label truncated to 59 chars so the `-vnc` label stays ≤ 63 chars
  (`toDesktopHostname` in `@homehost/shared`, pure + injective — the `-vnc`
  suffix can only come from this function, so SSH and desktop names never
  collide).
- Both stay one DNS level under `<baseDomain>`, so the single Let's Encrypt
  wildcard (`*.homehost.risktozero.sh`, DNS-01) covers them. Cloudflare
  Universal SSL does **not** cover deeper names on a normal zone and is not
  used for DNS-only traffic (see `docs/networking.md`).

## DNS: wildcard-only for desktops, per-VM for SSH
| Record       | Name                 | Value                                   | Written by                          |
| ------------ | -------------------- | --------------------------------------- | ----------------------------------- |
| SSH AAAA     | `<subdomain>`        | guest IPv6 (static, from `IPV6_PREFIX`) | worker `ensureAAAA` (existing path) |
| Desktop A/AAAA | `*-vnc.<base>`     | edge host (`*.dev` + `*.homehost` wildcards) | one-time Cloudflare wildcard records |
No per-VM desktop record is written at provision or deleted at teardown:
the two `*.dev.homehost.risktozero.sh` records (A → edge v4, AAAA → edge
host v6) plus `*.homehost.risktozero.sh` cover every current and future
desktop hostname. `EDGE_IPV6` is retired (was the per-VM desktop target;
removed from worker env + compose + `.env.dev`).

## Traefik route lifecycle (ratified with WorkerDesktop, 2026-09-17)

- Worker writes `infra/traefik/routes/gui-<instanceName>.yml` at provision,
  removes it at teardown (missing file after teardown = success).
- `panel.yml` stays checked in and is never touched by the worker.
- stop/start = no route churn (file stays; stopped VM reads as Traefik 502,
  rows show the existing `running`/`stopped` state honestly — no new
  `RequestStatus`).
- Backend scheme verdict: **https + `insecureSkipVerify`**. KasmVNC serves
  self-signed TLS on its websocket port (`-sslOnly 1`, snakeoil cert on the
  desk2 proof box; never `--no-ssl`). Evidence:
  `curl -k https://10.0.0.90:6090/ → 401`,
  `curl http://10.0.0.90:6090/ → empty reply`,
  and from inside the Traefik container
  `wget --no-check-certificate https://10.0.0.90:6090/ → 401 Unauthorized`
  (TLS handshake OK, auth expected).
- Backend target = **guest IPv4** (incusbr0 address in
  `server_requests.ipv4`, written post-boot when known), port =
  `desktop_port` (= `plan.desktop.kasmPort`, 6090). Not host-gateway, not
  a container DNS name, and NOT guest IPv6: the edge bridge has
  `EnableIPv6: false`, so the Traefik container has no v6 stack and cannot
  originate to the guest static v6, while guest v4 is verified end-to-end
  (container `ping 10.0.0.90` 0.41ms, `https://10.0.0.90:6090` → 401).
  Known risk: guest v4 is DHCP from incusbr0 dnsmasq (sticky in practice,
  not contractual); a changed lease stales the route until reprovision.

Exact template the worker writes (placeholders: `<instanceName>` is
`req-xxxxxxxx`, `<desktopHostname>` the FQDN, `<guestIpv4>`, `<kasmPort>`):

```yaml
http:
  routers:
    gui-<instanceName>:
      rule: "Host(`<desktopHostname>`)"
      entryPoints:
        - websecure
      service: gui-<instanceName>
      tls:
        certResolver: letsencrypt
    gui-<instanceName>-http:
      rule: "Host(`<desktopHostname>`)"
      entryPoints:
        - web
      middlewares:
        - gui-<instanceName>-https-redirect
      service: gui-<instanceName>
  middlewares:
    gui-<instanceName>-https-redirect:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    gui-<instanceName>:
      loadBalancer:
        servers:
          - url: "https://<guestIpv4>:<kasmPort>"
        serversTransport: gui-<instanceName>-transport
  serversTransports:
    gui-<instanceName>-transport:
      insecureSkipVerify: true
```

Follows the `panel.yml`/`dev.yml` pattern (per-file redirect middleware,
`letsencrypt` resolver). No edge-network fix needed: guest IPv4 on
incusbr0 is directly dialable from the Traefik container (verified above).

## KasmVNC reference (desk2 proof box, live 2026-09-17)

```text
kasmvncserver :5 -geometry 1280x720 -websocketPort 6090 \
  -FrameRate 60 -DynamicQualityMax 9 -DynamicQualityMin 8 \
  -VideoTime 5 -VideoArea 45 -TreatLossless 7 \
  -MaxVideoResolution 1280x720 -VideoScaling 0
```

Observed `ps` flags match plus `-sslOnly 1`,
`-cert /etc/ssl/certs/ssl-cert-snakeoil.pem`,
`-drinode /dev/dri/renderD128`. Password: `kasmvncpasswd -u ubuntu` works
headless (`/home/ubuntu/.kasmpasswd`, 0600). First-run prompts (user
permission + DE select) were pre-answered non-interactively
(`~/.vnc/.de-was-selected` present; `kasmvnc.yaml` logging-only).
Required packages: `dbus-x11`, `ssl-cert` (both installed on desk2).
xstartup:

```sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export XDG_CURRENT_DESKTOP=XFCE
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __NV_PRIME_RENDER_OFFLOAD=1
exec dbus-launch --exit-with-session /usr/bin/startxfce4 --compositor=off
```

## Omarchy image verdict (2026-09-17)

**No `omarchy` alias exists on `images:`** — `incus image list images: |
grep -i omarchy` returns zero rows. `archlinux/cloud` exists (container +
`VIRTUAL-MACHINE` builds), so the `desktop-omarchy` plan base
(`images:archlinux/cloud`) resolves; Omarchy-the-distro must be installed
post-boot (pacman/AUR) via cloud-init, not pulled as an image.
Custom-image spike path if bake-in is wanted later: launch
`images:archlinux/cloud` VM → install Omarchy → `incus publish` to a local
`omarchy-baked` image → point the plan at it. Not done in this slice.

Bake status (2026-09-18): pure builders for the future bake exist behind
the fail-closed gate — `omarchyPackages`, `omarchyRunCommands`, plus the
`desktop.env` branch in `appendDesktopToUserData`
(`apps/worker/src/desktop.ts`; Ubuntu cloud-init output byte-identical).
The Omarchy installer itself is still interactive-only (boot.sh needs a
TTY), so `index.ts` still refuses desktop-omarchy jobs. Flip = remove the
gate + take the arch user-data path. KasmVNC AUR package name and build
flags are unverified — see the `omarchyRunCommands` comments.

## GPU sharing limits (single GTX 1070)

- Host PCI: `42:00.0 GP104 [10de:1b81]` + `42:00.1` audio — one card, PCI
  1:1 passthrough cannot serve multiple tenants (same verdict as
  `docs/gui-desktop-notes.md`: guest glxgears 2778fps vs 518fps llvmpipe,
  zero VNC-feel change, keep the card for CUDA/transcode, not VNC).
- `nvidia-smi` on the host fails (`No supported GPUs were found` — no
  NVML driver bound), so no host-side encode path exists today.
- desk2 KasmVNC uses virtio DRI, not the NVIDIA card:
  `-drinode /dev/dri/renderD128` where
  `pci-0000:04:00.0-render -> ../renderD128` (virtio), while
  `pci-0000:07:00.0` owns the second render node. Per-app NVIDIA offload
  stays available inside XFCE via the `__GLX_VENDOR_LIBRARY_NAME=nvidia` /
  `__NV_PRIME_RENDER_OFFLOAD=1` env in xstartup — PRIME offload, not
  passthrough.
- Sell accordingly: default tier = usable desktop/apps (software encode),
  premium = single-GPU box, one tenant per card.

## Networking problems found (2026-09-17, with evidence)

1. **Edge bridge has no IPv6 — backend ratified to guest IPv4 instead.**
   `docker network inspect homehost-edge_default` → `"EnableIPv6": false`;
   `docker exec homehost-edge-traefik-1 ip addr` shows only `::1`, no global
   v6, so the container cannot originate to the guest static v6. Backend is
   therefore `https://<guest-ipv4>:<kasmPort>` (no brackets), verified:
   container → `ping 10.0.0.90` 0.41ms, `https://10.0.0.90:6090` → 401.
   Follow-on risk: guest v4 is DHCP from incusbr0 dnsmasq (sticky, not
   contractual); a changed lease stales the route until reprovision.
2. **Reference box has no global v6 (SSH leg).** `incus exec desk2 -- ip
addr` shows only `fe80::/64` link-local; direct-v6 SSH to provisioned
   desktops depends on the worker's static-v6 cloud-init path, unproven
   end-to-end on this box.
3. **Local `/etc/hosts` shadows public DNS.** `homehost.risktozero.sh` and
   one guest name resolve to `192.168.1.16` locally, while authoritative
   DNS (`@1.1.1.1`) says apex A `38.62.47.122`, no apex AAAA. Always probe
   DNS with `@1.1.1.1`/`@8.8.8.8`.
4. **Desktop DNS is wildcard-only (2026-09-17).** `*.dev.homehost.risktozero.sh`
  A → edge v4 + AAAA → edge host v6, plus `*.homehost.risktozero.sh`. No
  per-VM desktop record is written (worker) or needed. `EDGE_IPV6` retired.
5. **No host GPU driver.** `nvidia-smi` fails; single GTX 1070 is 1:1-only.
   No multi-tenant GPU story (see above).
6. **`check.sh` 80/443 MISS is a false alarm on the edge host.** Traefik
   itself binds `:80`/`:443` here (`ss -tln` shows both on `0.0.0.0` and
   `[::]`), so the "already bound" MISS fires on a healthy edge box.
   Pre-existing behavior, left untouched; the additive desktop probe below
   reports edge state independently.
