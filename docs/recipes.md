# Setup recipes

A request can carry a setup recipe (`recipeId` on `POST /api/requests`). Once
the box passes the readiness gate (see [networking.md](networking.md)) and is
marked `running`, the worker installs the recipe inside the box with fixed,
idempotent step scripts. The box stays usable over SSH the whole time;
`setupStatus` on the request shows where setup is.

## Requesting

`POST /api/requests` accepts `recipeId` (any id in `RECIPE_IDS`) and
`eulaAccepted`. It answers `400 invalid` when the recipe is not installable
yet ("coming soon": `code_server`, `minecraft_bedrock`, `valheim`), when it
needs a VM and the plan is a container (`docker`), or when it has a license
and `eulaAccepted` is not `true` (`minecraft_java`). `none` or no `recipeId`
is plain Ubuntu.

Stored on `server_requests` (migration 0015): `recipe_id` (null for plain
Ubuntu), `setup_status` (`none` exactly when there is no recipe, otherwise
`pending → running → done | failed`), `setup_step`, `setup_error` and
`eula_accepted_at`. The EULA acceptance is recorded as `eula_accepted_at`
at request time, and only for recipes that have a license. The worker
refuses to write Minecraft's `eula=true` without it.

`ServerRequest.gameAddress` is the box hostname once a game recipe finished
setup (`setupStatus: "done"`), otherwise null. Minecraft Java players type
just the hostname: the default port 25565 needs no suffix. Players need IPv6.

## What each recipe installs

| Recipe           | Steps                                                                                                         | Result                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `node`           | `update_packages`, `install_node`                                                                             | Ubuntu's `nodejs` and `npm`                                                         |
| `python`         | `update_packages`, `install_python`                                                                           | `python3`, `python3-venv`, `python3-pip`                                            |
| `docker`         | `update_packages`, `install_docker`                                                                           | `docker.io` and `docker-compose-v2`, `docker` enabled and started                   |
| `minecraft_java` | `update_packages`, `install_java`, `download_minecraft`, `configure_minecraft`, `start_service`, `wait_ready` | Latest official Minecraft Java server as `minecraft.service`, in a `screen` session |

Every recipe also adds a fixed line to `/etc/motd` saying what was installed.

All steps run apt non-interactively, wait for cloud-init (`cloud-init status
--wait`) and the dpkg lock first, and force IPv4 for apt and `curl -4`
because guests may lack an IPv6 default route. `update_packages` runs
`apt-get update` and installs `ca-certificates` and `curl`.

### Minecraft Java

- `install_java`: installs `screen` and `jq`, resolves the latest release
  from Mojang's official manifest
  (`https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`), reads
  the Java major version that release needs (`javaVersion.majorVersion`;
  26.x needs Java 25) and installs `openjdk-<major>-jre-headless`. The JVM is
  linked at `/usr/local/lib/homehost/minecraft-java` and the release is
  pinned in `/opt/minecraft/.homehost-release` so the download matches the
  installed Java. If Ubuntu has no such package, setup fails with
  `java_unavailable`.
- `download_minecraft`: downloads the pinned release's `server.jar` from
  Mojang to `/opt/minecraft/server.jar` and verifies its SHA-1 from the
  version JSON (`checksum_mismatch` otherwise; the bad file is discarded).
  An existing jar with the right SHA-1 is kept. The version is written to
  `/opt/minecraft/.homehost-version`.
- `configure_minecraft`: system user `minecraft` owning `/opt/minecraft`,
  `eula.txt` with `eula=true`, and `server.properties` defaults
  (`max-players=10`, `view-distance=8`, `simulation-distance=6`,
  `online-mode=true`, `enable-rcon=false`, empty `server-ip` so Java listens
  on IPv4 and IPv6). An existing `server.properties` and world are never
  overwritten.
- `start_service`: `/etc/systemd/system/minecraft.service` runs
  `screen -DmS minecraft <jvm> -Xms512M -Xmx<heap>M -jar server.jar nogui`
  as `minecraft` in `/opt/minecraft`. The heap is the plan memory minus
  512 MB, at least 1024 MB. The unit is enabled, so the server comes back
  after a reboot. `Restart=always` with `RestartSec=10`: screen exits 0
  even when Java crashes, so `on-failure` would never restart it. Stopping
  (`systemctl stop minecraft`) types `stop` into the console and waits for
  the world to save.
- `wait_ready`: waits up to 5 minutes for something to listen on 25565
  inside the box (world generation is slow), then the worker connects from
  the host to `[<box ipv6>]:25565` for up to `WORKER_READY_TIMEOUT_MS`.

Files: `/opt/minecraft` (jar, world, `server.properties`, logs),
`/etc/systemd/system/minecraft.service`, `/usr/local/lib/homehost/`.

Console: `minecraft-console` as root (SSH in as root first). Detach with
Ctrl-A then D; the server keeps running. It runs
`runuser -u minecraft -- script -qc "screen -x minecraft" /dev/null`: a plain
`sudo -u minecraft screen -r minecraft` from a root login fails with "Cannot
open your terminal" because the terminal belongs to root. Logs:
`journalctl -u minecraft` and `/opt/minecraft/logs/latest.log`.

## Failure and retry

Each step has a time limit. Apt-lock and network failures are retried
inside the step (3 runs, with backoff). Any other failure sets
`setup_status = 'failed'`, keeps the failing step in `setup_step`, and sets
`setup_error` to a stable code: `apt_failed`, `download_failed`,
`checksum_mismatch`, `java_unavailable`, `service_failed`, `not_ready`,
`timeout` or `unknown`. The job's `last_error` keeps the output tail for the
operator. The box is never reimaged or relaunched for a setup failure.

The owner retries with `POST /api/requests/:id/setup/retry` (only while the
box is `running` and setup is `failed`; `409` otherwise, `404` for anyone
else). It resets setup to `pending` and queues one `setup` job; the scripts
are idempotent, so the whole recipe re-runs safely on the same box.

## Worker jobs

Setup is its own `provision_jobs` action, `setup`. `provision_jobs_active_unique`
keys on `(request_id, action)`, so a request has at most one queued or
leased setup job; a second retry while one is queued gets `409`. The worker
queues it right after marking a box `running` (provision or start) when
`setup_status = 'pending'`. A setup job that finds the box stopped leaves
setup `pending` for the next start. A worker restart re-leases an
interrupted job and the steps re-run; after `WORKER_SETUP_ATTEMPTS` leases
(default 3) it fails with `unknown`. Jobs run one at a time, so a long setup
delays other queued jobs.

Activity events (actor "Homehost worker"): `setup_started` (detail: the
recipe id), `setup_done` (detail: the game address, or the recipe id), and
`setup_failed` (detail: the error code).
