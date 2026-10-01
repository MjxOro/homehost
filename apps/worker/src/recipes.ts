// Fixed setup step scripts, run inside the box with
// `incus exec <instance> -- bash -euo pipefail -c <script>`. No user text is
// ever interpolated: the only values are worker constants and the JVM heap,
// a number computed from the plan. Every script is idempotent so a retry
// from the dashboard re-runs the whole recipe safely on the same box.
import { MINECRAFT_PORT, SETUP_EXIT_CODES } from "@homehost/shared";
import type { SetupStepId } from "@homehost/shared";

const EXIT = SETUP_EXIT_CODES;

// Guests may lack an IPv6 default route, so apt and curl stay on IPv4 (same
// as the cloud-init apt config). DPkg::Lock::Timeout waits out unattended
// upgrades instead of failing on the dpkg lock.
const PRELUDE = `export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o Acquire::ForceIPv4=true -o Acquire::Retries=3 -o DPkg::Lock::Timeout=300"
fail() { echo "homehost-setup: $2" >&2; exit "$1"; }
wait_for_boot() {
  if command -v cloud-init >/dev/null 2>&1; then
    timeout 900 cloud-init status --wait >/dev/null 2>&1 || true
  fi
}
apt_install() {
  wait_for_boot
  apt-get $APT_OPTS install -y --no-install-recommends "$@" || fail ${EXIT.apt_failed} "apt-get install $* failed"
}
motd_line() {
  touch /etc/motd
  grep -qxF "$1" /etc/motd || printf '%s\\n' "$1" >> /etc/motd
}
fetch() {
  curl -4 -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 "$@"
}
`;

const UPDATE_PACKAGES = `wait_for_boot
apt-get $APT_OPTS update || fail ${EXIT.apt_failed} "apt-get update failed"
apt_install ca-certificates curl
`;

// Each Minecraft release names the Java it needs (26.x needs Java 25), so
// this resolves the latest release from Mojang's official manifest, installs
// that Java, and pins the release for download_minecraft. The JVM is linked
// at a fixed path so the unit never depends on the default `java`.
const INSTALL_JAVA = `apt_install screen jq
manifest=$(fetch https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) || fail ${EXIT.download_failed} "version manifest download failed"
version=$(printf '%s' "$manifest" | jq -er '.latest.release') || fail ${EXIT.download_failed} "manifest has no latest release"
version_url=$(printf '%s' "$manifest" | jq -er --arg v "$version" 'first(.versions[] | select(.id == $v) | .url)') || fail ${EXIT.download_failed} "manifest has no entry for $version"
[[ "$version_url" == https://piston-meta.mojang.com/* ]] || fail ${EXIT.download_failed} "version details are not on a Mojang host"
details=$(fetch "$version_url") || fail ${EXIT.download_failed} "version details download failed"
major=$(printf '%s' "$details" | jq -er '.javaVersion.majorVersion') || fail ${EXIT.download_failed} "no Java version for $version"
[[ "$major" =~ ^[0-9]+$ ]] || fail ${EXIT.download_failed} "malformed Java version for $version"
candidate=$(apt-cache policy "openjdk-$major-jre-headless" | awk '/Candidate:/ {print $2}')
if [ -z "$candidate" ] || [ "$candidate" = "(none)" ]; then
  fail ${EXIT.java_unavailable} "openjdk-$major-jre-headless (needed by Minecraft $version) is not in this system's apt sources"
fi
apt_install "openjdk-$major-jre-headless"
set -- /usr/lib/jvm/java-"$major"-openjdk-*/bin/java
[ -x "$1" ] || fail ${EXIT.apt_failed} "Java $major is not installed"
"$1" -version >/dev/null 2>&1 || fail ${EXIT.apt_failed} "Java $major is not runnable"
mkdir -p /usr/local/lib/homehost /opt/minecraft
ln -sfn "$1" /usr/local/lib/homehost/minecraft-java
printf '%s\\n' "$version_url" > /opt/minecraft/.homehost-release
echo "Java $major for Minecraft $version"
`;

// Official server jar for the release install_java pinned, verified against
// the version's SHA-1. An existing jar that already matches is kept.
const DOWNLOAD_MINECRAFT = `dir=/opt/minecraft
[ -s "$dir/.homehost-release" ] || fail ${EXIT.download_failed} "no Minecraft release pinned"
version_url=$(cat "$dir/.homehost-release")
[[ "$version_url" == https://piston-meta.mojang.com/* ]] || fail ${EXIT.download_failed} "pinned release is not on a Mojang host"
details=$(fetch "$version_url") || fail ${EXIT.download_failed} "version details download failed"
version=$(printf '%s' "$details" | jq -er '.id') || fail ${EXIT.download_failed} "version details have no id"
url=$(printf '%s' "$details" | jq -er '.downloads.server.url') || fail ${EXIT.download_failed} "no server download for $version"
sha=$(printf '%s' "$details" | jq -er '.downloads.server.sha1') || fail ${EXIT.download_failed} "no server checksum for $version"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail ${EXIT.download_failed} "malformed server checksum"
[[ "$url" == https://piston-data.mojang.com/* || "$url" == https://launcher.mojang.com/* ]] || fail ${EXIT.download_failed} "server download is not on a Mojang host"
if [ -f "$dir/server.jar" ] && [ "$(sha1sum "$dir/server.jar" | cut -d' ' -f1)" = "$sha" ]; then
  echo "server.jar for $version already installed"
else
  tmp=$(mktemp "$dir/.server.jar.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  fetch -o "$tmp" "$url" || fail ${EXIT.download_failed} "server.jar download failed"
  got=$(sha1sum "$tmp" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || fail ${EXIT.checksum_mismatch} "server.jar SHA-1 $got does not match $sha"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dir/server.jar"
fi
printf '%s\\n' "$version" > "$dir/.homehost-version"
`;

// eula=true: the owner accepted the Minecraft EULA when requesting the box
// (recorded as eula_accepted_at). Existing settings and worlds are kept.
const CONFIGURE_MINECRAFT = `dir=/opt/minecraft
if ! id -u minecraft >/dev/null 2>&1; then
  useradd --system --home-dir "$dir" --no-create-home --shell /usr/sbin/nologin minecraft
fi
mkdir -p "$dir"
printf 'eula=true\\n' > "$dir/eula.txt"
if [ ! -e "$dir/server.properties" ]; then
  cat > "$dir/server.properties" <<'HOMEHOST_EOF'
motd=A Minecraft server on Homehost
max-players=10
view-distance=8
simulation-distance=6
online-mode=true
enable-rcon=false
server-ip=
server-port=${MINECRAFT_PORT}
HOMEHOST_EOF
fi
chown -R minecraft:minecraft "$dir"
`;

// The server runs inside a detached screen session so the owner can attach
// a console. screen exits 0 even when Java crashes, so Restart=always (not
// on-failure) is what keeps it running; `systemctl stop minecraft` still
// stops it for good. ExecStop types `stop` into the console and waits for
// the world to save before systemd moves on.
function startService(heapMb: number): string {
  return `[ -x /usr/local/lib/homehost/minecraft-java ] || fail ${EXIT.service_failed} "the Minecraft JVM link is missing"
mkdir -p /usr/local/lib/homehost
cat > /usr/local/lib/homehost/minecraft-stop <<'HOMEHOST_EOF'
#!/bin/sh
# Ask the server to save and stop through its console, then wait for it.
/usr/bin/screen -p 0 -S minecraft -X stuff "stop$(printf '\\r')" || exit 0
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
ExecStart=/usr/bin/screen -DmS minecraft /usr/local/lib/homehost/minecraft-java -Xms512M -Xmx${heapMb}M -jar server.jar nogui
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
systemctl daemon-reload || fail ${EXIT.service_failed} "systemctl daemon-reload failed"
systemctl enable minecraft.service || fail ${EXIT.service_failed} "could not enable minecraft.service"
if [ "$changed" = 1 ]; then
  systemctl restart minecraft.service || fail ${EXIT.service_failed} "could not start minecraft.service"
else
  systemctl start minecraft.service || fail ${EXIT.service_failed} "could not start minecraft.service"
fi
sleep 5
if ! systemctl is-active --quiet minecraft.service; then
  journalctl -u minecraft.service -n 30 --no-pager >&2 || true
  fail ${EXIT.service_failed} "minecraft.service is not active"
fi
motd_line "Minecraft Java server: minecraft.service, files in /opt/minecraft. Console: minecraft-console (detach with Ctrl-A then D)."
`;
}

// World generation is slow on small plans: allow 5 minutes to listen.
const WAIT_READY = `i=0
while [ "$i" -lt 100 ]; do
  if [ -n "$(ss -Hltn 'sport = :${MINECRAFT_PORT}')" ]; then
    echo "listening on ${MINECRAFT_PORT}"
    exit 0
  fi
  sleep 3
  i=$((i + 1))
done
journalctl -u minecraft.service -n 30 --no-pager >&2 || true
fail ${EXIT.not_ready} "nothing listening on ${MINECRAFT_PORT} after 5 minutes"
`;

const INSTALL_NODE = `apt_install nodejs npm
node --version >/dev/null || fail ${EXIT.apt_failed} "node is not runnable after install"
motd_line "Node.js and npm are installed (node, npm)."
`;

const INSTALL_PYTHON = `apt_install python3 python3-venv python3-pip
motd_line "Python 3 is installed with pip and venv (python3 -m venv .venv)."
`;

// Recommends kept on purpose: docker.io relies on them (apparmor, pigz, ...).
const INSTALL_DOCKER = `wait_for_boot
apt-get $APT_OPTS install -y docker.io docker-compose-v2 || fail ${EXIT.apt_failed} "apt-get install docker failed"
systemctl enable --now docker || fail ${EXIT.service_failed} "could not start docker"
docker info >/dev/null 2>&1 || fail ${EXIT.service_failed} "docker is not answering"
motd_line "Docker is installed with Compose (docker compose up -d)."
`;

/** Bash source for one step; `heapMb` is required by start_service. */
export function setupScript(
  step: SetupStepId,
  options: { heapMb: number | null },
): string {
  switch (step) {
    case "update_packages":
      return PRELUDE + UPDATE_PACKAGES;
    case "install_java":
      return PRELUDE + INSTALL_JAVA;
    case "download_minecraft":
      return PRELUDE + DOWNLOAD_MINECRAFT;
    case "configure_minecraft":
      return PRELUDE + CONFIGURE_MINECRAFT;
    case "start_service": {
      const heapMb = options.heapMb;
      if (heapMb === null || !Number.isInteger(heapMb) || heapMb <= 0)
        throw new Error(`start_service needs an integer heap, got ${heapMb}`);
      return PRELUDE + startService(heapMb);
    }
    case "wait_ready":
      return PRELUDE + WAIT_READY;
    case "install_node":
      return PRELUDE + INSTALL_NODE;
    case "install_python":
      return PRELUDE + INSTALL_PYTHON;
    case "install_docker":
      return PRELUDE + INSTALL_DOCKER;
  }
}
