# Map & Mission Editor server

A small FastAPI + SQLite backend: signed-in people store, open, update and delete **their own** maps.
It also serves the built editor, so one process is the whole site.

## Run it
```bash
cd server
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
MAP_SSO_ISSUER=https://dino.mr-salih.org python run.py      # http://127.0.0.1:8000
pytest                                                      # no network needed
```
For development run the editor beside it (`npm run dev` from the repo root; it proxies `/api` to port 8000).
To serve the editor from the server: `npm run build`, then `MAP_STATIC_DIR=../dist python run.py`.

## Settings (environment)
| Variable | Default | Meaning |
|---|---|---|
| `MAP_SSO_ISSUER` | required | DINO (planner-004) origin. Keys come from `<issuer>/oauth/jwks` |
| `MAP_SSO_AUDIENCE` | `kerf-sabre` | the JWT `aud` DINO issues for first-party clients |
| `MAP_SSO_CLIENT_ID` | `map-editor` | the only OAuth client whose tokens are accepted |
| `MAP_SSO_JWKS_URL` | issuer + `/oauth/jwks` | override the key-set address |
| `MAP_DB_PATH` | `maps.db` | SQLite file (back this up) |
| `MAP_STATIC_DIR` | empty | folder of the built editor to serve at `/` |
| `MAP_CORS_ORIGINS` | empty | comma list; only needed if the editor is on another origin (then build it with `VITE_API_URL`) |
| `MAP_MAX_DOC_BYTES` / `MAP_MAX_MAPS_PER_USER` | 1000000 / 200 | limits |
| `MAP_HOST` / `MAP_PORT` | 127.0.0.1 / 8000 | listen address. Put HTTPS in front of it for real use |

## API (`/api/v1`, `Authorization: Bearer <DINO access token>`)
- `GET /maps` list your maps (`id`, `title`, `version`, `updatedAt`), newest first
- `POST /maps {doc}` save a new map -> 201 `{id, version, updatedAt}`
- `GET /maps/{id}` open one -> `{..., doc}`
- `PUT /maps/{id} {doc, baseVersion?}` replace; a stale `baseVersion` is 409 `conflict` and changes nothing
- `DELETE /maps/{id}` -> 204
- `GET /health`

Another person's map is always 404. Errors are `{"error": {"code", "message"}}`.
