package worker

// GUI desktop bootstrap + Traefik route files for desktop VMs.
//
// Ubuntu-xfce path (live reference: desk2 proof box): xfce4 + KasmVNC are
// baked into the desktop image (infra/host/build-images.sh); cloud-init
// only does per-box config. It mints a fresh snakeoil TLS cert (the image
// ships none, so no two boxes share a key), writes an xstartup running
// `dbus-launch startxfce4 --compositor=off`, pre-answers both KasmVNC
// first-run prompts non-interactively (a headless `kasmvncpasswd -u` user
// with write permission, plus a pre-created `~/.vnc/.de-was-selected`
// marker so the DE picker never fires), then supervises the server with a
// systemd unit. KasmVNC keeps TLS on (self-signed snakeoil cert, readable
// via the ssl-cert group); Traefik terminates the public LE wildcard cert
// and proxies to the guest over https with insecureSkipVerify.
//
// Omarchy path: fail-closed. `images:archlinux/cloud` resolves (VM variant
// verified 2026-09-17, ~538 MiB), but Omarchy ships only an interactive
// installer (https://omarchy.org/install runs an Arch walkthrough via
// boot.sh, requiring a TTY), so there is no proven non-interactive bake.
// The worker refuses the job with an actionable message instead of
// launching a half-built box. The builders for that future bake
// (omarchyPackages, omarchyRunCommands, plus the env branch in
// appendDesktopToUserData) exist behind the gate in handleProvision so
// flipping it later is one line.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/MjxOro/homehost/apps/worker/internal/contract"
)

const desktopService = "kasmvnc-desktop.service"

// omarchyPackages is the pacman base for the omarchy bake (behind the
// fail-closed gate). The Hyprland stack belongs to the Omarchy installer;
// this covers build tooling for a future AUR step + KasmVNC runtime needs.
func omarchyPackages() []string {
	return []string{"base-devel", "git", "curl", "sudo", "xauth", "dbus"}
}

// omarchyUnavailable is the fail-closed message for desktop-omarchy. It
// names the missing prerequisite (installer automation), not the image.
func omarchyUnavailable(planID, image string) string {
	return planID + " unavailable: no non-interactive Omarchy installer exists " +
		"(https://omarchy.org/install runs an interactive Arch walkthrough via " +
		"boot.sh, requiring a TTY). Image " + image + " resolves, so installer " +
		"automation is the missing prerequisite. Retry with desktop-ubuntu, or " +
		"bake Arch+Omarchy manually and re-request."
}

// kasmFlags are the Xvnc flags of the sharp streaming profile (desk2
// bakeoff). IP blacklisting stays disabled: all edge traffic shares the
// Traefik container IP, so per-IP blacklisting would lock out every client
// after 5 anon hits. The OTP is 144-bit base64url; throttling adds nothing.
func kasmFlags(desktop contract.DesktopConfig) string {
	s := contract.SharpStreamProfile()
	return fmt.Sprintf("-geometry 1280x720 -websocketPort %d "+
		"-FrameRate %d -DynamicQualityMax %d "+
		"-DynamicQualityMin %d -VideoTime %d "+
		"-VideoArea %d -TreatLossless %d "+
		"-MaxVideoResolution %s -VideoScaling %d "+
		"-BlacklistThreshold 0",
		desktop.KasmPort, s.FrameRate, s.DynamicQualityMax, s.DynamicQualityMin, s.VideoTime,
		s.VideoArea, s.TreatLossless, s.MaxVideoResolution, s.VideoScaling)
}

// desktopXstartup runs XFCE without compositor, NVIDIA PRIME offload when present.
func desktopXstartup() string {
	return `#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export XDG_CURRENT_DESKTOP=XFCE
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __NV_PRIME_RENDER_OFFLOAD=1
exec dbus-launch --exit-with-session /usr/bin/startxfce4 --compositor=off
`
}

// desktopSystemdUnit supervises the display. Deltas vs the frozen desk2
// interactive command: `-fg` keeps the server in the foreground under
// Type=simple (daemonizing would read as exit and restart-loop into
// duplicate servers), and Restart=always replaces the vnc-watchdog.
func desktopSystemdUnit(desktop contract.DesktopConfig) string {
	return fmt.Sprintf(`[Unit]
Description=KasmVNC desktop on %[1]s (XFCE, browser on %[2]d)
After=network-online.target
Wants=network-online.target

[Service]
User=%[3]s
Environment=HOME=/home/%[3]s
ExecStart=/usr/bin/kasmvncserver %[1]s -fg -select-de xfce %[4]s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`, desktop.Display, desktop.KasmPort, desktop.User, kasmFlags(desktop))
}

// desktopRunCommands are the cloud-init runcmd lines (as root, after
// `write_files:`). `kasmvncpasswd` with an explicit file
// target writes headless from a 2-line pipe (proven on desk2); the
// pre-created write user silences the permission picker at first start.
func desktopRunCommands(username, password string) []string {
	u := username
	return []string{
		"id " + u + " || useradd -m -s /bin/bash " + u,
		"chown -R " + u + ":" + u + " /home/" + u + " || true",
		`printf '%s\n' '/var/log/syslog {' '  rotate 3' '  size 50M' '  missingok' '  notifempty' '  compress' '}' > /etc/logrotate.d/kasmvnc`,
		"usermod -a -G ssl-cert " + u,
		"make-ssl-cert generate-default-snakeoil --force-overwrite",
		"mkdir -p /home/" + u + "/.vnc && chown " + u + ":" + u + " /home/" + u + "/.vnc",
		`printf '%s\n%s\n' '` + password + `' '` + password + `' | sudo -u ` + u + " -H kasmvncpasswd -u " + u + " -w /home/" + u + "/.kasmpasswd && chown " + u + ":" + u + " /home/" + u + "/.kasmpasswd && chmod 0600 /home/" + u + "/.kasmpasswd",
		"chown " + u + ":" + u + " /home/" + u + "/.vnc/xstartup && chmod 0755 /home/" + u + "/.vnc/xstartup",
		"systemctl daemon-reload && systemctl enable --now " + desktopService,
	}
}

// omarchyRunCommands mirrors desktopRunCommands for the omarchy bake
// (behind the fail-closed gate) with Arch deltas: pacman instead of apt,
// KasmVNC built from the AUR as the unprivileged user (makepkg refuses
// root; package name and flags are UNVERIFIED), and an `ssl-cert` group
// created so the shared unit's snakeoil-cert read path keeps working.
func omarchyRunCommands(username, password string) []string {
	u := username
	return []string{
		"id " + u + " || useradd -m -s /bin/bash " + u,
		"chown -R " + u + ":" + u + " /home/" + u + " || true",
		`printf '%s\n' '/var/log/syslog {' '  rotate 3' '  size 50M' '  missingok' '  notifempty' '  compress' '}' > /etc/logrotate.d/kasmvnc`,
		"getent group ssl-cert || groupadd -r ssl-cert; usermod -a -G ssl-cert " + u,
		"pacman -Syu --noconfirm && pacman -S --noconfirm --needed xorg-server xorg-xauth",
		"su " + u + " -c 'git clone https://aur.archlinux.org/kasmvnc.git /tmp/kasmvnc-aur && cd /tmp/kasmvnc-aur && makepkg -si --noconfirm' && rm -rf /tmp/kasmvnc-aur",
		"mkdir -p /home/" + u + "/.vnc && chown " + u + ":" + u + " /home/" + u + "/.vnc",
		`printf '%s\n%s\n' '` + password + `' '` + password + `' | sudo -u ` + u + " -H kasmvncpasswd -u " + u + " -w /home/" + u + "/.kasmpasswd && chown " + u + ":" + u + " /home/" + u + "/.kasmpasswd && chmod 0600 /home/" + u + "/.kasmpasswd",
		"chown " + u + ":" + u + " /home/" + u + "/.vnc/xstartup && chmod 0755 /home/" + u + "/.vnc/xstartup",
		"systemctl daemon-reload && systemctl enable --now " + desktopService,
	}
}

func indentBlock(body string, spaces int) string {
	pad := strings.Repeat(" ", spaces)
	var lines []string
	for _, line := range strings.Split(body, "\n") {
		if line != "" {
			lines = append(lines, pad+line)
		}
	}
	return strings.Join(lines, "\n")
}

// appendDesktopToUserData splices the per-box desktop config into the VM
// user-data from buildUserData: the xstartup + systemd unit write_files
// entries and the bootstrap runcmd lines (omarchy, whose packages are not
// baked, also gets a packages list). A missing anchor is an error so
// template drift fails the job closed instead of launching a headless box
// on a desktop plan.
func appendDesktopToUserData(base string, desktop contract.DesktopConfig, username, password string) (string, error) {
	const filesAnchor = "runcmd:\n"
	if !strings.Contains(base, filesAnchor) {
		return "", errors.New("desktop bake: runcmd anchor missing in user-data")
	}
	out := base
	if desktop.Env == "omarchy" {
		var pkgLines strings.Builder
		pkgLines.WriteString("packages:\n")
		for _, p := range omarchyPackages() {
			pkgLines.WriteString("  - " + p + "\n")
		}
		out = strings.Replace(out, "write_files:\n", pkgLines.String()+"write_files:\n", 1)
	}
	files := "  - path: /home/" + username + "/.vnc/xstartup\n" +
		"    permissions: '0755'\n" +
		"    content: |\n" + indentBlock(desktopXstartup(), 6) + "\n" +
		"  - path: /etc/systemd/system/" + desktopService + "\n" +
		"    permissions: '0644'\n" +
		"    content: |\n" + indentBlock(desktopSystemdUnit(desktop), 6) + "\n"
	out = strings.Replace(out, filesAnchor, files+filesAnchor, 1)

	const runAnchor = "  - systemctl restart ssh\n"
	if !strings.Contains(out, runAnchor) {
		return "", errors.New("desktop bake: runcmd ssh anchor missing in user-data")
	}
	runCmds := desktopRunCommands(username, password)
	if desktop.Env == "omarchy" {
		runCmds = omarchyRunCommands(username, password)
	}
	var cmds strings.Builder
	for _, c := range runCmds {
		cmds.WriteString("  - " + c + "\n")
	}
	return strings.Replace(out, runAnchor, runAnchor+cmds.String(), 1), nil
}

// desktopRoute is one desktop VM's edge route.
type desktopRoute struct {
	instanceName    string
	desktopHostname string
	// backendHost is the guest IPv4: the edge net has IPv6 disabled, so the
	// guest's static v6 is unreachable from the Traefik container.
	backendHost string
	kasmPort    int
}

// desktopRouteFileName is env-scoped through the instance name (dev rows
// mint dev-req-*), so route files never collide across envs.
func desktopRouteFileName(instanceName string) string {
	return "gui-" + instanceName + ".yml"
}

// buildDesktopRouteYaml mirrors the panel.yml pattern: a websecure router
// with the LE wildcard cert plus a web router redirecting to https; the
// backend is https to the guest's self-signed KasmVNC, so the transport
// skips verify. Quoted verbatim in docs/desktop-gui.md.
func buildDesktopRouteYaml(spec desktopRoute) string {
	name := spec.instanceName
	host := "\"Host(`" + spec.desktopHostname + "`)\""
	return `http:
  routers:
    gui-` + name + `:
      rule: ` + host + `
      entryPoints:
        - websecure
      service: gui-` + name + `
      tls:
        certResolver: letsencrypt
    gui-` + name + `-http:
      rule: ` + host + `
      entryPoints:
        - web
      middlewares:
        - gui-` + name + `-https-redirect
      service: gui-` + name + `
  middlewares:
    gui-` + name + `-https-redirect:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    gui-` + name + `:
      loadBalancer:
        servers:
          - url: "https://` + spec.backendHost + `:` + fmt.Sprint(spec.kasmPort) + `"
        serversTransport: gui-` + name + `-transport
  serversTransports:
    gui-` + name + `-transport:
      insecureSkipVerify: true
`
}

// writeDesktopRoute writes the route file; Traefik watches the dir.
func (w *Worker) writeDesktopRoute(spec desktopRoute) error {
	if err := os.MkdirAll(w.cfg.RoutesDir, 0o755); err != nil {
		return err
	}
	file := filepath.Join(w.cfg.RoutesDir, desktopRouteFileName(spec.instanceName))
	return os.WriteFile(file, []byte(buildDesktopRouteYaml(spec)), 0o644)
}

// removeDesktopRoute deletes the route file; a missing file is success.
func (w *Worker) removeDesktopRoute(instanceName string) error {
	err := os.Remove(filepath.Join(w.cfg.RoutesDir, desktopRouteFileName(instanceName)))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
