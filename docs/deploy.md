# Deploys

Every merge to `main` runs `bun run prod:deploy` on the prod box
(`.github/workflows/deploy.yml`, self-hosted runner, one deploy at a time):

1. `git pull --ff-only`, then `bun run prod:release` for the rest. That is a
   fresh `bun run`, so it reads the `package.json` just pulled and a change
   to steps 2-6 applies to the same deploy
2. `bun install`
3. `prod:build` — `homehost-api:<sha>` and `homehost-web:<sha>`, with the
   short SHA baked in as `BUILD_SHA`
4. `prod:edge` — `docker compose up -d` for the edge Traefik and its socket
   proxy; a no-op unless `infra/traefik/compose.yml` changed
5. `prod:rollout` — `infra/prod/rollout.sh`, below
6. `prod:worker` — rebuild and restart the host worker (`infra/worker/restart.sh`)

The panel stays up through step 5. The worker restart in step 6 pauses
provisioning for a few seconds; leased jobs resume.

## Rolling update

Traefik routes the panel from labels on the prod containers
(`infra/prod/compose.yml`): `/api/*` to the `api` replicas, everything else
to `web`. It only routes containers Docker reports healthy, and actively
health-checks each replica every 2s. `rollout.sh` rolls `api` first (a new
bundle may call routes only the new api has), then `web`. Per service:

1. Start one container on the new image beside the running one
   (`compose up --scale <svc>=2 --no-recreate`).
2. Wait until Docker reports it healthy (`ROLLOUT_HEALTH_TIMEOUT`, 180s).
3. Wait until the panel, through Traefik, answers with the new build:
   `/api/health` and `/version.json` both carry `"version":"<sha>"`
   (`ROLLOUT_ROUTE_TIMEOUT`, 60s).
4. Drain, then stop the old container. Traefik must drop a replica while it
   still serves: requests dialed at a container that is already gone stall
   until the dial fails (the first rehearsal measured 5s hangs). The api
   drains itself: on SIGTERM `/api/health` turns 503, it keeps serving for
   `SHUTDOWN_DRAIN_MS` (5s), then closes. Caddy cannot, so the script
   creates `/tmp/draining` in the old web container (its `/healthz` turns
   503) and waits `ROLLOUT_DRAIN_SECONDS` (5s) before stopping it. Web
   requests that still race the stop are retried by Traefik (`panel-retry`,
   static GETs only).

During the api drain, `/api/health` itself answers 503 from the old replica
for a second or two until Traefik's check drops it; every other route keeps
answering normally.

If step 2 or 3 fails, the new container is removed, its last log lines are
printed, the old one keeps serving and the deploy fails. Re-running a deploy
for the same commit is a no-op (compose config hash unchanged).

Open tabs keep the bundle they loaded. Each prod bundle knows its SHA and
polls `/version.json` (on focus, at most once a minute, and every five
minutes); when the server deploys a different build the signed-in shell
shows "A new version of Homehost is available" with a Refresh button. It
never reloads by itself.

## Rules this imposes

- **Migrations run while the previous release still serves.** The new api
  migrates on boot (`infra/prod/api-entrypoint.sh`) before the old one is
  stopped, so every migration must keep the previous release working:
  add columns/tables first, backfill, switch reads, and drop or rename in a
  later release. A rollback (redeploying an older SHA) never undoes schema.
- **API changes stay backward compatible for one release.** Old tabs keep
  calling the new api until they refresh.
- **No `container_name` or host `ports:` on api/web.** Two replicas run at
  once during every deploy.
- **Changing `traefik.*` labels costs a ~1s blip.** Traefik drops a service
  whose replicas disagree on labels ("defined multiple times with different
  configurations") and 404s until one config is left, so old and new cannot
  overlap. `rollout.sh` detects the change and removes the old replica the
  moment the new one is healthy (no drain). Every other deploy overlaps.
- Postgres is never rolled (`--no-recreate`). Changing its image or config
  is a planned restart: `bun run prod:up`.
- Desktop sessions (websockets through the api) drop when their api replica
  stops; the client reconnects to the new one.

## Rehearsal

Rehearse rollout changes on a throwaway stack with its own Traefik, never on
prod. The edge Traefik only routes compose project `homehost-prod`, so a
rehearsal project is invisible to it. Point the script at the rehearsal
project and its Traefik:

```bash
COMPOSE_PROJECT_NAME=hh-rehearsal \
COMPOSE_FILE=infra/prod/compose.yml:/tmp/hh-rehearsal/override.yml \
ROLLOUT_PROBE_URL=https://homehost.risktozero.sh:18443 \
ROLLOUT_CURL_OPTS="-k --resolve homehost.risktozero.sh:18443:127.0.0.1" \
TAG=<tag> bash infra/prod/rollout.sh
```

The override resets the Postgres host port, swaps `prod.env` for a scratch
env file, and points the `edge` network at the rehearsal Traefik's network.
