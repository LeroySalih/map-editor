# Deploying on the server

`./deploy.sh` gets the latest `main`, builds what changed, tests it, switches over, restarts the server only if its code changed, and checks `/health`.
If the new version fails a test, a build or the health check, the old one is put back.

## One-time setup
```bash
sudo mkdir -p /opt/map-editor /var/lib/map-editor && sudo chown "$USER" /opt/map-editor /var/lib/map-editor
git clone https://github.com/LeroySalih/map-editor /opt/map-editor && cd /opt/map-editor
cp deploy/map-editor.env.example deploy/map-editor.env && $EDITOR deploy/map-editor.env
sudo cp deploy/map-editor.service /etc/systemd/system/ && sudoedit /etc/systemd/system/map-editor.service   # paths, User
sudo systemctl daemon-reload && sudo systemctl enable map-editor
./deploy.sh --force        # first build and start
```
Needs git, Node 18+ (20 recommended), npm and Python 3.11+. Put HTTPS (Caddy, nginx) in front of port 5000 for real use,
and register `https://<your address>/` as a redirect URL for the `map-editor` client in DINO.

## Every time
```bash
./deploy.sh              # deploy the latest
./deploy.sh --check      # show what would happen, change nothing
./deploy.sh --force      # rebuild, retest and restart even if nothing changed
./deploy.sh --skip-tests --no-restart
```
Output is also appended to `.deploy-state/deploy.log`.

## What it will refuse to do
- run with edited tracked files, on another branch, or with commits that are not on `origin/main` (it only fast-forwards)
- run two deploys at once

## What it rebuilds when
| Changed | Action |
|---|---|
| `package.json`, `package-lock.json` or no `node_modules` | `npm ci` |
| `src/`, `index.html`, Vite/TS config, packages, a `VITE_*` value, or no `dist/` | tests, then build into `dist.new/` and swap it in (`dist.prev/` is kept for rollback) |
| `server/mapserver/`, `server/run.py`, `server/pyproject.toml`, or no `server/.venv` | `pip install`, server tests, restart, health check |
| only docs or tests | nothing is rebuilt |

The editor is swapped in with a directory rename, so visitors never see a half-built site, and an editor-only change needs no restart.
Without a systemd service called `map-editor` (or `DEPLOY_RESTART_CMD`) the script says so and leaves restarting to you.
