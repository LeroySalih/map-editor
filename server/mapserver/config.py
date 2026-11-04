"""Settings, all from MAP_* environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Settings:
    sso_issuer: str = ""                       # DINO (planner-004) origin, e.g. https://dino.mr-salih.org
    sso_audience: str = "kerf-sabre"           # the JWT `aud` DINO puts in tokens for first-party clients
    sso_client_id: str = "map-editor"          # the only OAuth client whose tokens are accepted
    sso_jwks_url: str = ""                     # default: <issuer>/oauth/jwks
    db_path: str = "maps.db"
    static_dir: str = ""                       # if set and present, the built editor is served at /
    cors_origins: list[str] = field(default_factory=list)  # empty = same origin only
    max_doc_bytes: int = 1_000_000
    max_maps_per_user: int = 200

    @property
    def jwks_url(self) -> str:
        return self.sso_jwks_url or f"{self.sso_issuer}/oauth/jwks"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        s = cls(
            sso_issuer=e.get("MAP_SSO_ISSUER", "").rstrip("/"),
            sso_audience=e.get("MAP_SSO_AUDIENCE", "kerf-sabre"),
            sso_client_id=e.get("MAP_SSO_CLIENT_ID", "map-editor"),
            sso_jwks_url=e.get("MAP_SSO_JWKS_URL", ""),
            db_path=e.get("MAP_DB_PATH", "maps.db"),
            static_dir=e.get("MAP_STATIC_DIR", ""),
            cors_origins=[o.strip() for o in e.get("MAP_CORS_ORIGINS", "").split(",") if o.strip()],
            max_doc_bytes=int(e.get("MAP_MAX_DOC_BYTES", "1000000")),
            max_maps_per_user=int(e.get("MAP_MAX_MAPS_PER_USER", "200")),
        )
        return s

    def check(self) -> None:
        if not self.sso_issuer and not self.sso_jwks_url:
            raise SystemExit("MAP_SSO_ISSUER is required: the server only accepts DINO sign-in.")
        Path(self.db_path).resolve().parent.mkdir(parents=True, exist_ok=True)
