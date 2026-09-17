import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STREAM_PROFILES } from "@homehost/shared";
import type { DesktopConfig } from "@homehost/shared";

/**
 * GUI desktop bootstrap + Traefik route files for desktop VMs.
 *
 * Ubuntu-xfce path (live reference: desk2 proof box): cloud-init installs
 * xfce4 + KasmVNC, writes an xstartup running
 * `dbus-launch startxfce4 --compositor=off`, pre-answers both KasmVNC
 * first-run prompts non-interactively (a headless `kasmvncpasswd -u` user
 * with write permission, plus a pre-created `~/.vnc/.de-was-selected`
 * marker so the DE picker never fires), then supervises the server with a
 * systemd unit. KasmVNC keeps TLS on (self-signed snakeoil cert, readable
 * via the ssl-cert group); Traefik terminates the public LE wildcard cert
 * and proxies to the guest over https with insecureSkipVerify.
 *
 * Omarchy path: fail-closed. `images:archlinux/cloud` resolves (VM variant
 * verified 2026-09-17, ~538 MiB), but Omarchy ships only an interactive
 * installer (https://omarchy.org/install runs an Arch walkthrough via
 * boot.sh, requiring a TTY), so there is no non-interactive bake. The
 * worker refuses the job with an actionable message instead of launching
 * a half-built box.
 */

export const DESKTOP_USER = "ubuntu";
export const DESKTOP_SERVICE = "kasmvnc-desktop.service";

const KASMVNC_VERSION = "1.3.3";
const KASMVNC_DEB = `kasmvncserver_noble_${KASMVNC_VERSION}_amd64.deb`;
/** KasmVNC is not in the Ubuntu archives; the deb comes from GitHub releases. */
export const KASMVNC_DEB_URL = `https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/${KASMVNC_DEB}`;

/** APT packages for the ubuntu-xfce bake (xauth + sudo are KasmVNC runtime needs). */
export function desktopPackages(): string[] {
  return [
    "xfce4",
    "tigervnc-standalone-server",
    "dbus-x11",
    "ssl-cert",
    "websockify",
    "xauth",
    "sudo",
  ];
}

/**
 * Fail-closed message for desktop-omarchy. Names the missing prerequisite
 * (non-interactive installer automation), not the image, which resolves.
 */
export function omarchyUnavailable(planId: string, image: string): string {
  return (
    `${planId} unavailable: no non-interactive Omarchy installer exists ` +
    `(https://omarchy.org/install runs an interactive Arch walkthrough via ` +
    `boot.sh, requiring a TTY). Image ${image} resolves, so installer ` +
    `automation is the missing prerequisite. Retry with desktop-ubuntu, or ` +
    `bake Arch+Omarchy manually and re-request.`
  );
}

/** KasmVNC Xvnc flags from the sharp streaming profile (desk2 bakeoff). */
function kasmFlags(desktop: DesktopConfig): string {
  const s = STREAM_PROFILES.sharp;
  return (
    `-geometry 1280x720 -websocketPort ${desktop.kasmPort} ` +
    `-FrameRate ${s.frameRate} -DynamicQualityMax ${s.dynamicQualityMax} ` +
    `-DynamicQualityMin ${s.dynamicQualityMin} -VideoTime ${s.videoTime} ` +
    `-VideoArea ${s.videoArea} -TreatLossless ${s.treatLossless} ` +
    `-MaxVideoResolution ${s.maxVideoResolution} -VideoScaling ${s.videoScaling}`
  );
}

/**
 * Exact interactive launch from the desk2 reference (frozen spec):
 * kasmvncserver :5 -geometry 1280x720 -websocketPort 6090 -FrameRate 60
 * -DynamicQualityMax 9 -DynamicQualityMin 8 -VideoTime 5 -VideoArea 45
 * -TreatLossless 7 -MaxVideoResolution 1280x720 -VideoScaling 0.
 */
export function kasmLaunchCommand(desktop: DesktopConfig): string {
  return `kasmvncserver ${desktop.display} ${kasmFlags(desktop)}`;
}

/** xstartup: XFCE without compositor, NVIDIA PRIME offload when present. */
export function desktopXstartup(): string {
  return `#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export XDG_CURRENT_DESKTOP=XFCE
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __NV_PRIME_RENDER_OFFLOAD=1
exec dbus-launch --exit-with-session /usr/bin/startxfce4 --compositor=off
`;
}

/**
 * Systemd unit supervising the display. Deltas vs the frozen interactive
 * command: `-fg` so the server stays in the foreground under Type=simple
 * (daemonizing under simple would read as exit and restart-loop into
 * duplicate servers), plus Restart=always instead of the vnc-watchdog.
 */
export function desktopSystemdUnit(desktop: DesktopConfig): string {
  return `[Unit]
Description=KasmVNC desktop on ${desktop.display} (XFCE, browser on ${desktop.kasmPort})
After=network-online.target
Wants=network-online.target

[Service]
User=${DESKTOP_USER}
Environment=HOME=/home/${DESKTOP_USER}
ExecStart=/usr/bin/kasmvncserver ${desktop.display} -fg ${kasmFlags(desktop)}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * cloud-init runcmd lines (run as root, after `packages:` and
 * `write_files:`). The Kasm password is the instance one-time password
 * (base64url, shell-safe): no new secret surface. Pre-answers, in order:
 * DE picker skipped via the `.de-was-selected` marker beside our own
 * xstartup; the write-permission picker skipped via a headless
 * `-u <user> -w` user created before the first server start
 * (kasmvncserver prompts only when users are missing, so a pre-created
 * write user silences both; prompting-off runs would exit(1) instead).
 * cloud-init runs `packages:` (with an apt update) before runcmd, so the
 * KasmVNC deb install below sees fresh lists. DEBIAN_FRONTEND is inline:
 * each runcmd line runs in its own shell, so an export would not persist.
 */
export function desktopRunCommands(
  username: string,
  password: string,
): string[] {
  return [
    `id ${username} || useradd -m -s /bin/bash ${username}`,
    `usermod -a -G ssl-cert ${username}`,
    `curl -fsSL -o /tmp/${KASMVNC_DEB} ${KASMVNC_DEB_URL} && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/${KASMVNC_DEB} && rm -f /tmp/${KASMVNC_DEB}`,
    `mkdir -p /home/${username}/.vnc && chown ${username}:${username} /home/${username}/.vnc`,
    `printf '%s\\n%s\\n' '${password}' '${password}' | sudo -u ${username} -H kasmvncpasswd -u ${username} -w`,
    `touch /home/${username}/.vnc/.de-was-selected && chown ${username}:${username} /home/${username}/.vnc/.de-was-selected`,
    `chown ${username}:${username} /home/${username}/.vnc/xstartup && chmod 0755 /home/${username}/.vnc/xstartup`,
    `systemctl daemon-reload && systemctl enable --now ${DESKTOP_SERVICE}`,
  ];
}
function indentBlock(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * Splice the desktop bake into the VM user-data built by
 * buildInstanceAccess: extra APT packages, the xstartup + systemd unit
 * write_files entries, and the bootstrap runcmd lines. Throws when an
 * anchor is missing so a template drift fails the job closed instead of
 * launching a headless box on a desktop plan.
 */
export function appendDesktopToUserData(
  base: string,
  desktop: DesktopConfig,
  username: string,
  password: string,
): string {
  const pkgAnchor = "packages:\n  - openssh-server\n";
  if (!base.includes(pkgAnchor)) {
    throw new Error("desktop bake: packages anchor missing in user-data");
  }
  let out = base.replace(
    pkgAnchor,
    `${pkgAnchor}${desktopPackages()
      .map((p) => `  - ${p}\n`)
      .join("")}`,
  );

  const filesAnchor = "runcmd:\n";
  if (!out.includes(filesAnchor)) {
    throw new Error("desktop bake: runcmd anchor missing in user-data");
  }
  const files = [
    `  - path: /home/${username}/.vnc/xstartup\n` +
      `    permissions: '0755'\n` +
      `    content: |\n${indentBlock(desktopXstartup(), 6)}\n`,
    `  - path: /etc/systemd/system/${DESKTOP_SERVICE}\n` +
      `    permissions: '0644'\n` +
      `    content: |\n${indentBlock(desktopSystemdUnit(desktop), 6)}\n`,
  ].join("");
  out = out.replace(filesAnchor, `${files}${filesAnchor}`);

  const runAnchor = "  - systemctl restart ssh\n";
  if (!out.includes(runAnchor)) {
    throw new Error("desktop bake: runcmd ssh anchor missing in user-data");
  }
  const cmds = desktopRunCommands(username, password)
    .map((c) => `  - ${c}\n`)
    .join("");
  return out.replace(runAnchor, `${runAnchor}${cmds}`);
}

export interface DesktopRouteSpec {
  instanceName: string;
  desktopHostname: string;
  /**
   * Traefik backend target: the guest IPv4 (incusbr0 lease, stored in
   * server_requests.ipv4). The edge net has IPv6 disabled, so the guest's
   * static v6 is unreachable from the Traefik container; guest v4 is
   * verified reachable (ping + https 401 to KasmVNC).
   */
  backendHost: string;
  kasmPort: number;
}

export function desktopRouteFileName(instanceName: string): string {
  return `gui-${instanceName}.yml`;
}

/** Traefik routes dir, relative to the repo root (the worker's cwd). */
function routesDir(): string {
  return join(process.cwd(), "infra", "traefik", "routes");
}

/**
 * Per-VM edge route, mirroring the panel.yml/dev.yml pattern: websecure
 * router with the LE wildcard cert plus a web router redirecting to https.
 * Backend is https to the guest IPv4 on the plan's kasmPort (KasmVNC
 * serves self-signed TLS there), so the transport skips verify. Flat
 * single-level `-vnc` host keeps the existing wildcard cert valid.
 * Template ratified with EdgeDesktop; quoted verbatim in docs/desktop-gui.md.
 */
export function buildDesktopRouteYaml(spec: DesktopRouteSpec): string {
  const name = spec.instanceName;
  return `http:
  routers:
    gui-${name}:
      rule: "Host(\`${spec.desktopHostname}\`)"
      entryPoints:
        - websecure
      service: gui-${name}
      tls:
        certResolver: letsencrypt
    gui-${name}-http:
      rule: "Host(\`${spec.desktopHostname}\`)"
      entryPoints:
        - web
      middlewares:
        - gui-${name}-https-redirect
      service: gui-${name}
  middlewares:
    gui-${name}-https-redirect:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    gui-${name}:
      loadBalancer:
        servers:
          - url: "https://${spec.backendHost}:${spec.kasmPort}"
        serversTransport: gui-${name}-transport
  serversTransports:
    gui-${name}-transport:
      insecureSkipVerify: true
`;
}

/** Write the route file (Traefik watches the dir, no restart needed). */
export async function writeDesktopRoute(
  spec: DesktopRouteSpec,
): Promise<string> {
  const dir = routesDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, desktopRouteFileName(spec.instanceName));
  await writeFile(file, buildDesktopRouteYaml(spec), "utf8");
  return file;
}

/** Remove the route file; a missing file is success (already torn down). */
export async function removeDesktopRoute(instanceName: string): Promise<void> {
  await rm(join(routesDir(), desktopRouteFileName(instanceName)), {
    force: true,
  });
}
