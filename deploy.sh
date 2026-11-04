#!/usr/bin/env bash
# Deploy the Map & Mission Editor on the server (run from anywhere: ./deploy.sh).
#   1. fast-forward this checkout to the latest origin/main (never merges, never rewrites history)
#   2. install and build only what changed (npm packages, the editor, the Python environment)
#   3. run the tests BEFORE anything goes live
#   4. swap the new editor in and restart the server only if its code changed
#   5. check /health; if the new version does not answer, put the old one back
# Settings live in deploy/map-editor.env (see deploy/README.md). Options: --check --force --skip-tests --no-restart
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE="${DEPLOY_SERVICE:-map-editor}"
ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT/deploy/map-editor.env}"
STATE="$ROOT/.deploy-state"
FORCE=0; SKIP_TESTS=0; NO_RESTART=0; CHECK=0

usage() {
  cat <<USAGE
Usage: ./deploy.sh [--check] [--force] [--skip-tests] [--no-restart]
  --check        show what would happen, change nothing
  --force        rebuild, retest and restart even if nothing changed
  --skip-tests   do not run the tests (not recommended)
  --no-restart   do not restart the server
USAGE
}
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;; --force) FORCE=1 ;; --skip-tests) SKIP_TESTS=1 ;; --no-restart) NO_RESTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }

PULLED=0; SWAPPED=0; RESTARTED=0; ROLLED=0; PREV=""; OLD_HASH=""

mkdir -p "$STATE"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE/lock"
  flock -n 9 || { log "ERROR: another deploy is already running."; exit 1; }
fi
exec > >(tee -a "$STATE/deploy.log") 2>&1

healthy() {
  local url="${DEPLOY_HEALTH_URL:-http://127.0.0.1:${MAP_PORT:-5000}/health}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "$url" >/dev/null 2>&1
  else
    server/.venv/bin/python -c 'import sys,urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)' "$url" >/dev/null 2>&1
  fi
}
wait_healthy() { local i; for i in $(seq 1 25); do healthy && return 0; sleep 1; done; return 1; }

# 0 = restarted, 2 = nothing to restart with, anything else = the restart failed
restart_service() {
  if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then bash -c "$DEPLOY_RESTART_CMD"; return; fi
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE" >/dev/null 2>&1; then
    if [ "$(id -u)" = 0 ]; then systemctl restart "$SERVICE"; else sudo -n systemctl restart "$SERVICE"; fi
    return
  fi
  return 2
}

rollback() {
  trap - ERR
  set +e
  [ "$PULLED" = 1 ] && [ "$ROLLED" = 0 ] || return 0
  ROLLED=1
  log "Rolling back to ${PREV:0:8} ..."
  git reset --hard --quiet "$PREV"
  rm -rf dist.new
  if [ "$SWAPPED" = 1 ] && [ -d dist.prev ]; then
    rm -rf dist.failed; mv dist dist.failed; mv dist.prev dist; rm -rf dist.failed
    [ -n "$OLD_HASH" ] && echo "$OLD_HASH" > "$STATE/build-env"
  fi
  if [ "$RESTARTED" = 1 ]; then
    restart_service
    if wait_healthy; then log "Rolled back: the previous version is running again."
    else log "WARNING: rolled back, but the server is still not answering. Check: journalctl -u $SERVICE -n 50"; fi
  else
    log "Rolled back. (Anything installed for the new version is left in place; the next deploy reconciles it.)"
  fi
}
die() { log "ERROR: $*"; rollback; exit 1; }
on_err() { local code=$?; log "ERROR: a step failed (exit $code, line ${BASH_LINENO[0]})."; rollback; exit "$code"; }
trap on_err ERR

# ---- before touching anything -------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed on this server."; }
need git; need node; need npm; need python3
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || die "Node 18 or newer is needed (20 is recommended): found $(node -v)."
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || die "Python 3.11 or newer is needed: found $(python3 -V)."

if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  log "Note: $ENV_FILE does not exist. Copy deploy/map-editor.env.example there and edit it (the editor is built with its VITE_* values)."
fi

[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "This checkout is on '$(git rev-parse --abbrev-ref HEAD)', not '$BRANCH'."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Tracked files were edited on this server. Commit or discard those changes first (git status)."
log "Fetching origin/$BRANCH ..."
git fetch --quiet origin "$BRANCH" || die "Could not reach the git remote."
PREV="$(git rev-parse HEAD)"; NEW="$(git rev-parse "origin/$BRANCH")"
git merge-base --is-ancestor "$PREV" "$NEW" || die "This checkout has commits that are not on origin/$BRANCH, or the branch was rewritten. Not touching it."

CHANGED="$(git diff --name-only "$PREV" "$NEW")"
changed() { printf '%s\n' "$CHANGED" | grep -Eq "$1"; }
BUILD_HASH="$(env | grep '^VITE_' | sort | sha256sum | cut -d' ' -f1)"
OLD_HASH="$(cat "$STATE/build-env" 2>/dev/null || true)"

NEED_NPM=0; NEED_BUILD=0; NEED_PIP=0; NEED_SERVER=0
{ [ ! -d node_modules ] || changed '^package(-lock)?\.json$'; } && NEED_NPM=1
{ [ "$NEED_NPM" = 1 ] || [ ! -f dist/index.html ] || [ "$BUILD_HASH" != "$OLD_HASH" ] \
  || changed '^(src/|index\.html$|vite\.config\.ts$|tsconfig\.json$|package(-lock)?\.json$)'; } && NEED_BUILD=1
{ [ ! -x server/.venv/bin/python ] || changed '^server/pyproject\.toml$'; } && NEED_PIP=1
{ [ "$NEED_PIP" = 1 ] || changed '^server/(mapserver/|run\.py$|pyproject\.toml$)'; } && NEED_SERVER=1
if [ "$FORCE" = 1 ]; then NEED_NPM=1; NEED_BUILD=1; NEED_PIP=1; NEED_SERVER=1; fi

yn() { [ "$1" = 1 ] && echo yes || echo no; }
log "Deployed: ${PREV:0:8}   Latest: ${NEW:0:8}   (branch $BRANCH)"
log "Plan: npm install: $(yn $NEED_NPM) | build editor: $(yn $NEED_BUILD) | python install: $(yn $NEED_PIP) | restart server: $(yn $NEED_SERVER) | tests: $([ "$SKIP_TESTS" = 1 ] && echo skipped || echo yes)"

if [ "$CHECK" = 1 ]; then
  [ "$PREV" = "$NEW" ] || { log "Commits to deploy:"; git log --oneline "$PREV..$NEW"; }
  log "--check: nothing was changed."; exit 0
fi

if [ "$PREV" = "$NEW" ] && [ "$NEED_NPM$NEED_BUILD$NEED_PIP$NEED_SERVER" = "0000" ]; then
  if wait_healthy; then log "Already up to date and the server is answering. Nothing to do."
  else log "Already up to date, but the server is not answering at ${DEPLOY_HEALTH_URL:-http://127.0.0.1:${MAP_PORT:-5000}/health}. Use --force to rebuild and restart."; fi
  exit 0
fi

# ---- get the latest -------------------------------------------------------------------------------
if [ "$PREV" != "$NEW" ]; then
  log "Updating ${PREV:0:8} -> ${NEW:0:8}:"; git log --oneline "$PREV..$NEW"
  git merge --ff-only --quiet "origin/$BRANCH"
  PULLED=1
fi
PULLED=1   # from here on a failure puts the checkout back to $PREV

# ---- install, test, build (nothing is live yet) ----------------------------------------------------------
if [ "$NEED_NPM" = 1 ]; then log "Installing npm packages (npm ci) ..."; npm ci --no-audit --no-fund --loglevel=error; fi
if [ "$NEED_PIP" = 1 ]; then
  log "Installing the Python server ..."
  [ -x server/.venv/bin/python ] || python3 -m venv server/.venv
  server/.venv/bin/pip install --quiet --disable-pip-version-check -e "./server[dev]"
fi
if [ "$SKIP_TESTS" = 0 ]; then
  if [ "$NEED_BUILD" = 1 ]; then log "Editor tests ..."; npx vitest run --reporter=dot; fi
  if [ "$NEED_SERVER" = 1 ]; then log "Server tests ..."; (cd server && .venv/bin/python -m pytest -q); fi
fi
if [ "$NEED_BUILD" = 1 ]; then
  log "Building the editor ..."
  rm -rf dist.new
  npx tsc --noEmit
  npx vite build --outDir dist.new --emptyOutDir --logLevel warn
  [ -f dist.new/index.html ] || die "The build produced no index.html."
fi

# ---- go live ------------------------------------------------------------------------------------------
if [ "$NEED_BUILD" = 1 ]; then
  rm -rf dist.prev
  if [ -d dist ]; then mv dist dist.prev; fi
  mv dist.new dist
  SWAPPED=1
  echo "$BUILD_HASH" > "$STATE/build-env"
  log "New editor is live (the old one is kept in dist.prev for rollback)."
fi

if [ "$NEED_SERVER" = 1 ] && [ "$NO_RESTART" = 0 ]; then
  log "Restarting the server ..."
  rc=0; restart_service || rc=$?
  if [ "$rc" = 0 ]; then
    RESTARTED=1
    wait_healthy || die "The server did not answer at ${DEPLOY_HEALTH_URL:-http://127.0.0.1:${MAP_PORT:-5000}/health} within 25 s after the restart."
    log "Server is healthy."
  elif [ "$rc" = 2 ]; then
    log "WARNING: no way to restart the server was found (no systemd service '$SERVICE' and no DEPLOY_RESTART_CMD). Restart it yourself to use the new server code."
  else
    die "The restart command failed (exit $rc)."
  fi
elif [ "$NEED_SERVER" = 1 ]; then
  log "Server code changed but --no-restart was given: restart it yourself."
else
  log "Server code did not change: no restart needed (the new editor files are served straight away)."
fi

trap - ERR
log "Done. Now at $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
