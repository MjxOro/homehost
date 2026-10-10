package worker

// Fixed setup step scripts, run inside the box with
// `incus exec <instance> -- bash -euo pipefail -c <script>`. No user text is
// ever interpolated: the only values are contract constants and the JVM
// heap, a number computed from the plan. Every script is idempotent so a
// retry from the dashboard re-runs the whole recipe safely on the same box.

import (
	"fmt"
	"strings"
	"text/template"

	"github.com/MjxOro/homehost/apps/worker/internal/contract"
)

// Guests may lack an IPv6 default route, so apt and curl stay on IPv4 (same
// as the cloud-init apt config). DPkg::Lock::Timeout waits out unattended
// upgrades instead of failing on the dpkg lock.
const prelude = `export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o Acquire::ForceIPv4=true -o Acquire::Retries=3 -o DPkg::Lock::Timeout=300"
fail() { echo "homehost-setup: $2" >&2; exit "$1"; }
wait_for_boot() {
  if command -v cloud-init >/dev/null 2>&1; then
    timeout 900 cloud-init status --wait >/dev/null 2>&1 || true
  fi
}
apt_install() {
  wait_for_boot
  apt-get $APT_OPTS install -y --no-install-recommends "$@" || fail {{.Exit.apt_failed}} "apt-get install $* failed"
}
motd_line() {
  touch /etc/motd
  grep -qxF "$1" /etc/motd || printf '%s\n' "$1" >> /etc/motd
}
fetch() {
  curl -4 -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 "$@"
}
`

const updatePackages = `wait_for_boot
apt-get $APT_OPTS update || fail {{.Exit.apt_failed}} "apt-get update failed"
apt_install ca-certificates curl
`

// Each Minecraft release names the Java it needs (26.x needs Java 25), so
// this resolves the latest release from Mojang's official manifest, installs
// that Java, and pins the release for download_minecraft. The JVM is linked
// at a fixed path so the unit never depends on the default `java`.
const installJava = `apt_install screen jq
manifest=$(fetch https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) || fail {{.Exit.download_failed}} "version manifest download failed"
version=$(printf '%s' "$manifest" | jq -er '.latest.release') || fail {{.Exit.download_failed}} "manifest has no latest release"
version_url=$(printf '%s' "$manifest" | jq -er --arg v "$version" 'first(.versions[] | select(.id == $v) | .url)') || fail {{.Exit.download_failed}} "manifest has no entry for $version"
[[ "$version_url" == https://piston-meta.mojang.com/* ]] || fail {{.Exit.download_failed}} "version details are not on a Mojang host"
details=$(fetch "$version_url") || fail {{.Exit.download_failed}} "version details download failed"
major=$(printf '%s' "$details" | jq -er '.javaVersion.majorVersion') || fail {{.Exit.download_failed}} "no Java version for $version"
[[ "$major" =~ ^[0-9]+$ ]] || fail {{.Exit.download_failed}} "malformed Java version for $version"
candidate=$(apt-cache policy "openjdk-$major-jre-headless" | awk '/Candidate:/ {print $2}')
if [ -z "$candidate" ] || [ "$candidate" = "(none)" ]; then
  fail {{.Exit.java_unavailable}} "openjdk-$major-jre-headless (needed by Minecraft $version) is not in this system's apt sources"
fi
apt_install "openjdk-$major-jre-headless"
set -- /usr/lib/jvm/java-"$major"-openjdk-*/bin/java
[ -x "$1" ] || fail {{.Exit.apt_failed}} "Java $major is not installed"
"$1" -version >/dev/null 2>&1 || fail {{.Exit.apt_failed}} "Java $major is not runnable"
mkdir -p /usr/local/lib/homehost /opt/minecraft
ln -sfn "$1" /usr/local/lib/homehost/minecraft-java
printf '%s\n' "$version_url" > /opt/minecraft/.homehost-release
echo "Java $major for Minecraft $version"
`

// Official server jar for the release install_java pinned, verified against
// the version's SHA-1. An existing jar that already matches is kept.
const downloadMinecraft = `dir=/opt/minecraft
[ -s "$dir/.homehost-release" ] || fail {{.Exit.download_failed}} "no Minecraft release pinned"
version_url=$(cat "$dir/.homehost-release")
[[ "$version_url" == https://piston-meta.mojang.com/* ]] || fail {{.Exit.download_failed}} "pinned release is not on a Mojang host"
details=$(fetch "$version_url") || fail {{.Exit.download_failed}} "version details download failed"
version=$(printf '%s' "$details" | jq -er '.id') || fail {{.Exit.download_failed}} "version details have no id"
url=$(printf '%s' "$details" | jq -er '.downloads.server.url') || fail {{.Exit.download_failed}} "no server download for $version"
sha=$(printf '%s' "$details" | jq -er '.downloads.server.sha1') || fail {{.Exit.download_failed}} "no server checksum for $version"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail {{.Exit.download_failed}} "malformed server checksum"
[[ "$url" == https://piston-data.mojang.com/* || "$url" == https://launcher.mojang.com/* ]] || fail {{.Exit.download_failed}} "server download is not on a Mojang host"
if [ -f "$dir/server.jar" ] && [ "$(sha1sum "$dir/server.jar" | cut -d' ' -f1)" = "$sha" ]; then
  echo "server.jar for $version already installed"
else
  tmp=$(mktemp "$dir/.server.jar.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  fetch -o "$tmp" "$url" || fail {{.Exit.download_failed}} "server.jar download failed"
  got=$(sha1sum "$tmp" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || fail {{.Exit.checksum_mismatch}} "server.jar SHA-1 $got does not match $sha"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dir/server.jar"
fi
printf '%s\n' "$version" > "$dir/.homehost-version"
`

// eula=true: the owner accepted the Minecraft EULA when requesting the box
// (recorded as eula_accepted_at). Existing settings and worlds are kept.
const configureMinecraft = `dir=/opt/minecraft
if ! id -u minecraft >/dev/null 2>&1; then
  useradd --system --home-dir "$dir" --no-create-home --shell /usr/sbin/nologin minecraft
fi
mkdir -p "$dir"
printf 'eula=true\n' > "$dir/eula.txt"
if [ ! -e "$dir/server.properties" ]; then
  cat > "$dir/server.properties" <<'HOMEHOST_EOF'
motd=A Minecraft server on Homehost
max-players=10
view-distance=8
simulation-distance=6
online-mode=true
enable-rcon=false
server-ip=
server-port={{.MinecraftPort}}
HOMEHOST_EOF
fi
chown -R minecraft:minecraft "$dir"
`

// The server runs inside a detached screen session so the owner can attach
// a console. screen exits 0 even when Java crashes, so Restart=always (not
// on-failure) is what keeps it running; `systemctl stop minecraft` still
// stops it for good. ExecStop types `stop` into the console and waits for
// the world to save before systemd moves on.
const startService = `[ -x /usr/local/lib/homehost/minecraft-java ] || fail {{.Exit.service_failed}} "the Minecraft JVM link is missing"
mkdir -p /usr/local/lib/homehost
cat > /usr/local/lib/homehost/minecraft-stop <<'HOMEHOST_EOF'
#!/bin/sh
# Ask the server to save and stop through its console, then wait for it.
/usr/bin/screen -p 0 -S minecraft -X stuff "stop$(printf '\r')" || exit 0
i=0
while [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$i" -lt 100 ]; do
  sleep 1
  i=$((i + 1))
done
HOMEHOST_EOF
chmod 755 /usr/local/lib/homehost/minecraft-stop
cat > /usr/local/bin/minecraft-console <<'HOMEHOST_EOF'
#!/bin/sh
# Attach to the Minecraft server console. Detach with Ctrl-A then D.
# script(1) gives the minecraft user a terminal it owns, which screen needs.
exec runuser -u minecraft -- script -qc "screen -x minecraft" /dev/null
HOMEHOST_EOF
chmod 755 /usr/local/bin/minecraft-console
unit=/etc/systemd/system/minecraft.service
tmp=$(mktemp)
cat > "$tmp" <<'HOMEHOST_EOF'
[Unit]
Description=Minecraft Java server (Homehost)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minecraft
Group=minecraft
WorkingDirectory=/opt/minecraft
ExecStart=/usr/bin/screen -DmS minecraft /usr/local/lib/homehost/minecraft-java -Xms512M -Xmx{{.HeapMb}}M -jar server.jar nogui
ExecStop=/usr/local/lib/homehost/minecraft-stop $MAINPID
TimeoutStopSec=120
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
HOMEHOST_EOF
changed=0
if ! cmp -s "$tmp" "$unit"; then
  install -m 644 "$tmp" "$unit"
  changed=1
fi
rm -f "$tmp"
systemctl daemon-reload || fail {{.Exit.service_failed}} "systemctl daemon-reload failed"
systemctl enable minecraft.service || fail {{.Exit.service_failed}} "could not enable minecraft.service"
if [ "$changed" = 1 ]; then
  systemctl restart minecraft.service || fail {{.Exit.service_failed}} "could not start minecraft.service"
else
  systemctl start minecraft.service || fail {{.Exit.service_failed}} "could not start minecraft.service"
fi
sleep 5
if ! systemctl is-active --quiet minecraft.service; then
  journalctl -u minecraft.service -n 30 --no-pager >&2 || true
  fail {{.Exit.service_failed}} "minecraft.service is not active"
fi
motd_line "Minecraft Java server: minecraft.service, files in /opt/minecraft. Console: minecraft-console (detach with Ctrl-A then D)."
`

// World generation is slow on small plans: allow 5 minutes to listen.
const waitReady = `i=0
while [ "$i" -lt 100 ]; do
  if [ -n "$(ss -Hltn 'sport = :{{.MinecraftPort}}')" ]; then
    echo "listening on {{.MinecraftPort}}"
    exit 0
  fi
  sleep 3
  i=$((i + 1))
done
journalctl -u minecraft.service -n 30 --no-pager >&2 || true
fail {{.Exit.not_ready}} "nothing listening on {{.MinecraftPort}} after 5 minutes"
`

const installNode = `apt_install nodejs npm
node --version >/dev/null || fail {{.Exit.apt_failed}} "node is not runnable after install"
motd_line "Node.js and npm are installed (node, npm)."
`

const installPython = `apt_install python3 python3-venv python3-pip
motd_line "Python 3 is installed with pip and venv (python3 -m venv .venv)."
`

// Recommends kept on purpose: docker.io relies on them (apparmor, pigz, ...).
const installDocker = `wait_for_boot
apt-get $APT_OPTS install -y docker.io docker-compose-v2 || fail {{.Exit.apt_failed}} "apt-get install docker failed"
systemctl enable --now docker || fail {{.Exit.service_failed}} "could not start docker"
docker info >/dev/null 2>&1 || fail {{.Exit.service_failed}} "docker is not answering"
motd_line "Docker is installed with Compose (docker compose up -d)."
`

var stepScripts = map[string]*template.Template{}

func init() {
	for step, body := range map[string]string{
		"update_packages":     updatePackages,
		"install_java":        installJava,
		"download_minecraft":  downloadMinecraft,
		"configure_minecraft": configureMinecraft,
		"start_service":       startService,
		"wait_ready":          waitReady,
		"install_node":        installNode,
		"install_python":      installPython,
		"install_docker":      installDocker,
	} {
		stepScripts[step] = template.Must(template.New(step).Option("missingkey=error").Parse(prelude + body))
	}
}

// setupScript is the bash source for one step; heapMb is required by
// start_service.
func setupScript(step string, heapMb *int) (string, error) {
	tmpl, ok := stepScripts[step]
	if !ok {
		return "", fmt.Errorf("no setup script for step %s", step)
	}
	data := map[string]any{
		"Exit":          contract.SetupExitCodes,
		"MinecraftPort": contract.MinecraftPort,
		"HeapMb":        0,
	}
	if step == "start_service" {
		if heapMb == nil || *heapMb <= 0 {
			return "", fmt.Errorf("start_service needs a positive heap, got %v", heapMb)
		}
		data["HeapMb"] = *heapMb
	}
	var out strings.Builder
	if err := tmpl.Execute(&out, data); err != nil {
		return "", err
	}
	return out.String(), nil
}
