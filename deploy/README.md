# Deploying on the server (Docker)

`./deploy.sh` gets the latest `main`, builds a Docker image, starts it as the container `map-editor` on the external
Docker network `dino-app`, waits for its health check, and puts the previous image back if the new one does not come up.
The server needs only **git** and **Docker with Compose v2**. No Node, no Python.

## One-time setup
```bash
git clone https://github.com/LeroySalih/map-editor /opt/map-editor && cd /opt/map-editor
cp deploy/map-editor.env.example deploy/map-editor.env && $EDITOR deploy/map-editor.env
docker network ls | grep dino-app          # it must exist: the DINO stack owns it
./deploy.sh
```
The user running it must be able to use Docker (member of the `docker` group, or use `sudo`).
The network is declared `external: true` in `docker-compose.yml`, so it is never created or removed here.
If it is missing, `deploy.sh` says so; to make it yourself: `docker network create dino-app`.

Register the `map-editor` client in DINO with the redirect URL `https://<your address>/` (trailing slash, exact match) and an Audience equal to `MAP_SSO_AUDIENCE` in `deploy/map-editor.env` (`map-editor`). The container publishes **no host port**:
other containers on `dino-app` (your reverse proxy) reach it at `http://map-editor:5000`. To reach it from the server itself,
add `ports: ["127.0.0.1:5000:5000"]` to `docker-compose.yml`.

## Every time
```bash
./deploy.sh              # deploy the latest
./deploy.sh --check      # show what would happen, change nothing
./deploy.sh --force      # rebuild and recreate even if nothing changed
./deploy.sh --skip-tests # build without running the tests (not recommended)
```
Output is also appended to `.deploy-state/deploy.log`.

## What happens
1. Refuses if tracked files were edited on the server, it is not on `main`, it has commits that are not on `origin/main`, the network or `deploy/map-editor.env` is missing, or another deploy is running. It only fast-forwards.
2. `docker compose build`: the **Dockerfile runs the editor tests, then the server tests, then builds the editor**. A failing test or type error means no image, and the running container is not touched.
3. `docker compose up -d`: Compose replaces the container only if the image changed (a docs-only change rebuilds from cache and changes nothing).
4. Waits up to 90 s for the container's health check (`/health`). If it is unhealthy or crash-looping, the logs are shown, the checkout goes back to the previous commit and the previous image is started again. On the very first deploy there is nothing to go back to, so the broken container is stopped.
5. Keeps the five newest per-commit image tags (`map-editor:<sha>`) plus `map-editor:previous`.

## Data and settings
- The SQLite database is on the Docker volume `map-editor_map-editor-data` (`/data/maps.db` in the container). **Back it up**, e.g.
  `docker run --rm -v map-editor_map-editor-data:/data -v "$PWD":/out alpine tar czf /out/maps-backup.tgz -C /data .`
- `deploy/map-editor.env` holds `VITE_*` (baked into the editor at build time; changing one triggers a rebuild) and `MAP_SSO_*` (read by the server). The port, database path and editor folder are fixed in `docker-compose.yml`.
- Logs: `docker logs -f map-editor`. Shell: `docker exec -it map-editor sh`. The container runs as a non-root user and restarts automatically (`unless-stopped`).
- Rolling back by hand: `docker tag map-editor:<sha> map-editor:latest && docker compose --env-file deploy/map-editor.env up -d --no-build`.
