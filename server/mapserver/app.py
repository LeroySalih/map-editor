"""FastAPI app: /api/v1 maps for the signed-in DINO user (own maps only), /health, and optionally the built editor at /."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import Body, Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import Verifier
from .config import Settings
from .errors import ApiError
from .store import Store
from .validate import validate_doc

log = logging.getLogger("mapserver")


def create_app(cfg: Settings | None = None, verifier: Verifier | None = None) -> FastAPI:
    cfg = cfg or Settings.from_env()
    store = Store(cfg.db_path)
    verifier = verifier or Verifier(cfg)
    app = FastAPI(title="Map & Mission Editor server", docs_url=None, redoc_url=None)

    if cfg.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=cfg.cors_origins, allow_methods=["GET", "POST", "PUT", "DELETE"],
                           allow_headers=["Authorization", "Content-Type"])

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError) -> JSONResponse:
        return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=e.status)

    @app.middleware("http")
    async def cap_body(request: Request, call_next):
        # Refuse an oversized upload before reading it. (Anything that slips past is checked again after parsing.)
        n = request.headers.get("content-length")
        if n and n.isdigit() and int(n) > cfg.max_doc_bytes + 1_000:
            return JSONResponse({"error": {"code": "too_large", "message": "That map is too big to store."}}, status_code=413)
        return await call_next(request)

    def me(request: Request) -> str:
        h = request.headers.get("authorization", "")
        if not h.lower().startswith("bearer ") or not h[7:].strip():
            raise ApiError(401, "unauthorized", "Sign in with DINO first.")
        return verifier.user_id(h[7:].strip())

    def checked(doc: Any) -> str:
        title = validate_doc(doc)
        if len(json.dumps(doc)) > cfg.max_doc_bytes:
            raise ApiError(413, "too_large", "That map is too big to store.")
        return title

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/maps")
    def list_maps(user: str = Depends(me)) -> list[dict[str, Any]]:
        return store.list(user)

    @app.post("/api/v1/maps", status_code=201)
    def create_map(user: str = Depends(me), doc: dict[str, Any] = Body(..., embed=True)) -> dict[str, Any]:
        title = checked(doc)
        if store.count(user) >= cfg.max_maps_per_user:
            raise ApiError(409, "too_many_maps", f"You can keep up to {cfg.max_maps_per_user} maps. Delete one first.")
        return store.create(user, title, doc)

    @app.get("/api/v1/maps/{map_id}")
    def get_map(map_id: str, user: str = Depends(me)) -> dict[str, Any]:
        m = store.get(user, map_id)
        if m is None:
            raise ApiError(404, "not_found", "No such map.")
        return m

    @app.put("/api/v1/maps/{map_id}")
    def put_map(map_id: str, user: str = Depends(me), doc: dict[str, Any] = Body(..., embed=True),
                baseVersion: int | None = Body(None, embed=True)) -> dict[str, Any]:
        r = store.update(user, map_id, checked(doc), doc, baseVersion)
        if r is None:
            raise ApiError(404, "not_found", "No such map.")
        if r == "conflict":
            raise ApiError(409, "conflict", "This map was changed somewhere else. Open it again, or save a copy.")
        return r  # type: ignore[return-value]

    @app.delete("/api/v1/maps/{map_id}", status_code=204)
    def delete_map(map_id: str, user: str = Depends(me)) -> None:
        if not store.delete(user, map_id):
            raise ApiError(404, "not_found", "No such map.")

    if cfg.static_dir and Path(cfg.static_dir).is_dir():
        app.mount("/", StaticFiles(directory=cfg.static_dir, html=True), name="editor")
    return app
