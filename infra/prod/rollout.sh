#!/usr/bin/env bash
# Rolling update of the prod api and web, one service at a time and never
# below one serving container: start the new container beside the old one,
# wait until Docker reports it healthy and Traefik answers with its build,
# then stop the old one (the api drains first, see apps/api/src/server.ts).
# A new container that never gets there is removed and the old one keeps
# serving, so a bad image fails the deploy instead of taking the panel down.
#
# Env (defaults are prod; docs/deploy.md has the rehearsal values):
#   TAG                     image tag and build SHA (default: git short SHA)
#   COMPOSE_FILE, COMPOSE_PROJECT_NAME   standard compose overrides
#   ROLLOUT_PROBE_URL       panel origin as Traefik serves it
#   ROLLOUT_CURL_OPTS       curl flags for the probe (default pins the name to loopback)
#   ROLLOUT_HEALTH_TIMEOUT  seconds a new container gets to turn healthy
#   ROLLOUT_ROUTE_TIMEOUT   seconds Traefik gets to route to it
#   ROLLOUT_DRAIN_SECONDS   web drain before stop (> Traefik check interval + timeout)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export TAG=${TAG:-$(git rev-parse --short HEAD)}
export COMPOSE_FILE=${COMPOSE_FILE:-infra/prod/compose.yml}
probe_url=${ROLLOUT_PROBE_URL:-https://homehost.risktozero.sh}
read -r -a curl_opts <<<"${ROLLOUT_CURL_OPTS---resolve homehost.risktozero.sh:443:127.0.0.1}"
health_timeout=${ROLLOUT_HEALTH_TIMEOUT:-180}
route_timeout=${ROLLOUT_ROUTE_TIMEOUT:-60}
drain_seconds=${ROLLOUT_DRAIN_SECONDS:-5}

log() { printf 'rollout: %s %s\n' "$(date -u +%T.%3N)" "$*"; }

# Both answer {"version":"<build>",...} from the container that served them.
probe_path() {
  case $1 in
    api) echo /api/health ;;
    web) echo /version.json ;;
  esac
}

wait_healthy() {
  local id=$1 state deadline=$((SECONDS + health_timeout))
  while ((SECONDS < deadline)); do
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
    case $state in
      "running healthy") return 0 ;;
      "running unhealthy" | exited* | dead*)
        log "new container is $state"
        return 1
        ;;
    esac
    sleep 0.2
  done
  log "new container not healthy after ${health_timeout}s"
  return 1
}

# Traefik picks healthy containers up from Docker events and its own health
# check; the old container may only go once the panel answers with the new build.
wait_routed() {
  local url deadline=$((SECONDS + route_timeout))
  url=$probe_url$(probe_path "$1")
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 2 "${curl_opts[@]}" "$url" 2>/dev/null | grep -q "\"version\":\"$TAG\""; then
      return 0
    fi
    sleep 0.5
  done
  log "$url never answered with $TAG within ${route_timeout}s"
  return 1
}

traefik_labels() {
  docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$1" | { grep '^traefik\.' || true; } | sort
}

# The new replica never got there: drop it, leave the old one serving, fail.
abort_new() {
  log "$1: keeping the old container; last logs of the new one:"
  docker logs --tail 40 "$2" >&2 || true
  docker rm -f "$2" >/dev/null
  exit 1
}

# Take a replica out of Traefik before it stops: requests dialed at a container
# that is already gone stall until the dial fails. The api drains itself on
# SIGTERM (SHUTDOWN_DRAIN_MS); Caddy cannot, so web gets the flag that fails
# its /healthz, then one Traefik check interval passes before the stop.
drain() {
  [[ $1 == web ]] || return 0
  docker exec "$2" touch /tmp/draining
  sleep "$drain_seconds"
}

roll() {
  local svc=$1 want new id
  local -a old stale
  # Stopped leftovers of an aborted rollout would be restarted by --scale.
  mapfile -t stale < <(docker compose ps -aq --status exited --status created "$svc")
  if ((${#stale[@]} > 0)); then
    docker rm "${stale[@]}" >/dev/null
  fi
  mapfile -t old < <(docker compose ps -q "$svc")
  if ((${#old[@]} == 0)); then
    log "$svc: nothing running, starting it"
    docker compose up -d --wait --no-deps --no-build "$svc"
    wait_routed "$svc" || exit 1
    log "$svc: now on $TAG"
    return
  fi
  # Same config hash = same image, env and labels: nothing to roll.
  want=$(docker compose config --hash "$svc" | awk '{print $2}')
  if ! for id in "${old[@]}"; do
    docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id"
  done | grep -qvx "$want"; then
    log "$svc: already current"
    return
  fi

  log "$svc: starting $TAG beside ${#old[@]} running"
  docker compose up -d --no-deps --no-build --no-recreate --scale "$svc=$((${#old[@]} + 1))" "$svc"
  new=$(comm -13 <(printf '%s\n' "${old[@]}" | sort) <(docker compose ps -q "$svc" | sort))
  if [[ -z $new || $new == *$'\n'* ]]; then
    log "$svc: expected exactly one new container, got '${new//$'\n'/ }'"
    exit 1
  fi
  # Traefik drops a service whose replicas carry different labels ("defined
  # multiple times with different configurations") and 404s until only one
  # config is left. A deploy that changes the labels cannot overlap old and
  # new, so it removes the old replica the moment the new one turns healthy:
  # a ~1s blip instead of a router outage for the whole rollout. An old replica
  # without labels (served by file routes before the cutover) cannot clash.
  local old_labels
  old_labels=$(traefik_labels "${old[0]}")
  if [[ -n $old_labels && $(traefik_labels "$new") != "$old_labels" ]]; then
    log "$svc: Traefik labels changed, switching over without overlap"
    wait_healthy "$new" || abort_new "$svc" "$new"
    docker rm -f "${old[@]}" >/dev/null
    wait_routed "$svc" || exit 1
    log "$svc: now on $TAG"
    return
  fi
  if ! wait_healthy "$new" || ! wait_routed "$svc"; then
    abort_new "$svc" "$new"
  fi
  for id in "${old[@]}"; do
    drain "$svc" "$id"
    docker stop "$id" >/dev/null
    docker rm "$id" >/dev/null
  done
  log "$svc: now on $TAG"
}

# Postgres is never rolled; --no-recreate leaves a running one untouched.
docker compose up -d --wait --no-recreate postgres
# api first: a new web bundle may call routes only the new api has.
roll api
roll web
