#!/usr/bin/env bash
# Deploy the Map & Mission Editor on the server as a Docker container. Needs only git and Docker (Compose v2):
# no Node, no Python. Run from anywhere: ./deploy.sh
#   1. fast-forward this checkout to the latest origin/main (never merges, never rewrites history)
#   2. build the image (the Dockerfile runs the editor and server tests, then builds the editor): a failing test means no image
#   3. start the new container on the external Docker network `dino-app`
#   4. wait for its health check; if it does not become healthy, put the previous image back
# Settings live in deploy/map-editor.env (see deploy/README.md). Options: --check --force --skip-tests
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BRANCH="${DEPLOY_BRANCH:-main}"
ENV_FILE="$ROOT/deploy/map-editor.env"
STATE="$ROOT/.deploy-state"
IMAGE="map-editor"
CONTAINER="map-editor"
NETWORK="dino-app"
HEALTH_WAIT="${DEPLOY_HEALTH_WAIT:-90}"
FORCE=0; SKIP_TESTS=0; CHECK=0

usage() {
  cat <<USAGE
Usage: ./deploy.sh [--check] [--force] [--skip-tests]
  --check        show what would happen, change nothing
  --force        rebuild and recreate the container even if nothing changed
  --skip-tests   build without running the tests (not recommended)
USAGE
}
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;; --force) FORCE=1 ;; --skip-tests) SKIP_TESTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }

PULLED=0; STARTED=0; ROLLED=0; PREV=""; OLD_ID=""

mkdir -p "$STATE"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE/lock"
  flock -n 9 || { log "ERROR: another deploy is already running."; exit 1; }
fi
exec > >(tee -a "$STATE/deploy.log" 9>&-) 2>&1   # (tee must not hold the lock after we exit)

dc() { docker compose --env-file "$ENV_FILE" "$@"; }
image_id() { docker image inspect -f '{{.Id}}' "$IMAGE:latest" 2>/dev/null || true; }
# healthy | starting | unhealthy | exited | missing ...
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing; }
restarts() { docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0; }
container_logs() { docker logs --tail 25 "$CONTAINER" 2>&1 | sed 's/^/    | /' || true; }

wait_healthy() {
  local i s
  for ((i = 0; i < HEALTH_WAIT; i++)); do
    s="$(health)"
    case "$s" in
      healthy) return 0 ;;
      unhealthy|exited|dead|missing) return 1 ;;
    esac
    [ "$(restarts)" -ge 2 ] && return 1   # crash-looping
    sleep 1
  done
  return 1
}

rollback() {
  trap - ERR
  set +e
  [ "$PULLED" = 1 ] && [ "$ROLLED" = 0 ] || return 0
  ROLLED=1
  cd "$ROOT"
  log "Rolling back to ${PREV:0:8} ..."
  git reset --hard --quiet "$PREV"
  if [ "$STARTED" = 1 ]; then
    if [ -n "$OLD_ID" ] && docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
      docker tag "$IMAGE:previous" "$IMAGE:latest"
      dc up -d --no-build --remove-orphans
      if wait_healthy; then log "Rolled back: the previous version is running again."
      else log "WARNING: rolled back, but the container is not healthy. Check: docker logs $CONTAINER"; container_logs; fi
    else
      dc stop
      log "This was the first deploy, so there is no earlier version to go back to. The new container was stopped. Fix the problem and run ./deploy.sh again."
    fi
  else
    log "Rolled back. The running container was not touched."
  fi
}
die() { log "ERROR: $*"; rollback; exit 1; }
on_err() { local code=$?; log "ERROR: a step failed (exit $code, line ${BASH_LINENO[0]})."; rollback; exit "$code"; }
trap on_err ERR

# ---- before touching anything -------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed on this server."; }
need git; need docker
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is needed ('docker compose'). Install the docker-compose-plugin package."
docker info >/dev/null 2>&1 || die "Docker is not running, or this user may not use it (add the user to the 'docker' group, or run with sudo)."
docker network inspect "$NETWORK" >/dev/null 2>&1 \
  || die "The Docker network '$NETWORK' does not exist. It is declared external in docker-compose.yml, so start the stack that owns it first (or, to make it yourself: docker network create $NETWORK)."
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Copy deploy/map-editor.env.example there and edit it."
grep -Eq '^MAP_SSO_ISSUER=.+' "$ENV_FILE" || die "MAP_SSO_ISSUER is not set in $ENV_FILE: the server only accepts DINO sign-in and will not start without it."

[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "This checkout is on '$(git rev-parse --abbrev-ref HEAD)', not '$BRANCH'."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Tracked files were edited on this server. Commit or discard those changes first (git status)."
log "Fetching origin/$BRANCH ..."
git fetch --quiet origin "$BRANCH" || die "Could not reach the git remote."
PREV="$(git rev-parse HEAD)"; NEW="$(git rev-parse "origin/$BRANCH")"
git merge-base --is-ancestor "$PREV" "$NEW" || die "This checkout has commits that are not on origin/$BRANCH, or the branch was rewritten. Not touching it."

BUILD_HASH="$(grep -E '^VITE_' "$ENV_FILE" | sort | sha256sum | cut -d' ' -f1)"
OLD_HASH="$(cat "$STATE/build-env" 2>/dev/null || true)"
OLD_ID="$(image_id)"
RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"

NEED_BUILD=0
if [ "$FORCE" = 1 ] || [ "$PREV" != "$NEW" ] || [ -z "$OLD_ID" ] || [ "$BUILD_HASH" != "$OLD_HASH" ]; then NEED_BUILD=1; fi
NEED_UP=0
if [ "$NEED_BUILD" = 1 ] || [ "$RUNNING" != true ]; then NEED_UP=1; fi

yn() { [ "$1" = 1 ] && echo yes || echo no; }
log "Deployed: ${PREV:0:8}   Latest: ${NEW:0:8}   (branch $BRANCH)"
log "Plan: build image: $(yn $NEED_BUILD) | update container: $(yn $NEED_UP) (only replaced if the image changed) | tests: $([ "$SKIP_TESTS" = 1 ] && echo skipped || echo "yes, during the build")"

if [ "$CHECK" = 1 ]; then
  [ "$PREV" = "$NEW" ] || { log "Commits to deploy:"; git log --oneline "$PREV..$NEW"; }
  log "--check: nothing was changed."; exit 0
fi

if [ "$NEED_BUILD$NEED_UP" = "00" ]; then
  if [ "$(health)" = healthy ]; then log "Already up to date and the container is healthy. Nothing to do."
  else log "Already up to date, but the container is '$(health)'. Use --force to rebuild and recreate it."; fi
  exit 0
fi

# ---- get the latest -------------------------------------------------------------------------------
if [ "$PREV" != "$NEW" ]; then
  log "Updating ${PREV:0:8} -> ${NEW:0:8}:"; git log --oneline "$PREV..$NEW"
  git merge --ff-only --quiet "origin/$BRANCH"
fi
PULLED=1   # from here on a failure puts the checkout back to $PREV

# ---- build (nothing running is touched yet) ----------------------------------------------------------
if [ "$NEED_BUILD" = 1 ]; then
  if [ -n "$OLD_ID" ]; then docker tag "$IMAGE:latest" "$IMAGE:previous"; fi   # kept for rollback
  RUN_TESTS=$([ "$SKIP_TESTS" = 1 ] && echo 0 || echo 1); export RUN_TESTS
  log "Building the image (this runs the tests) ..."
  dc build --pull
  docker tag "$IMAGE:latest" "$IMAGE:$(git rev-parse --short HEAD)"
fi

# ---- go live ------------------------------------------------------------------------------------------
log "Starting the container on network '$NETWORK' ..."
STARTED=1
dc up -d --no-build --remove-orphans
if ! wait_healthy; then
  container_logs
  die "The container did not become healthy (state: $(health); waited up to ${HEALTH_WAIT}s)."
fi
echo "$BUILD_HASH" > "$STATE/build-env"
log "Container is healthy."

# keep the five newest per-commit tags, and drop dangling images this project left behind
{ docker images "$IMAGE" --format '{{.Tag}}' | grep -E '^[0-9a-f]{7,40}$' | tail -n +6 | while read -r t; do docker rmi "$IMAGE:$t" >/dev/null 2>&1 || true; done; } || true
docker image prune -f --filter "label=app=$IMAGE" >/dev/null 2>&1 || true

trap - ERR
log "Done. Now at $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
