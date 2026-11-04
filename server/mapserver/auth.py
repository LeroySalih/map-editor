"""Sign in with DINO (planner-004): verify its RS256 JWT access tokens offline against its published keys (JWKS).

Same rules as Kerf Sabre's sso.py: RS256 only, header typ at+jwt, iss/aud/exp/nbf/sub required, the OAuth client must be ours.
Only `sub` (the DINO user ID) is used. The token is never stored or logged, and no name or email is read here.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
from collections.abc import Callable
from typing import Any

import jwt
from jwt.algorithms import RSAAlgorithm

from .config import Settings
from .errors import ApiError

log = logging.getLogger("mapserver.auth")

LEEWAY_S = 30
KEY_TTL_S = 300             # keys are trusted this long without a refresh
UNKNOWN_KID_REFETCH_S = 30  # an unknown key ID may mean a rotation; never refetch more often than this
ID_OK = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
KNOWN_ROLES = frozenset({"pupil", "teacher", "admin", "technician"})


def _http_get_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "map-editor-server"})
    with urllib.request.urlopen(req, timeout=5) as r:  # noqa: S310 (operator-configured https URL)
        return json.loads(r.read().decode())


def _peek(token: str) -> dict[str, Any]:
    """The issuer, audience and client of a token that failed a check, for the log only. The signature is NOT verified here and
    the subject (the person) is deliberately left out."""
    try:
        c = jwt.decode(token, options={"verify_signature": False})
        return {k: c.get(k) for k in ("iss", "aud", "client_id")}
    except jwt.PyJWTError:
        return {}


class Verifier:
    def __init__(self, cfg: Settings, fetch: Callable[[str], dict[str, Any]] | None = None,
                 clock: Callable[[], float] = time.monotonic):
        self.cfg = cfg
        self.fetch = fetch or _http_get_json
        self.clock = clock
        self._keys: dict[str, Any] = {}
        self._fetched_at: float | None = None
        self._last_attempt: float | None = None
        self._lock = threading.Lock()

    def _refresh(self) -> None:
        self._last_attempt = self.clock()
        doc = self.fetch(self.cfg.jwks_url)
        keys: dict[str, Any] = {}
        for jwk in doc.get("keys", []):
            if jwk.get("kty") == "RSA" and jwk.get("kid") and jwk.get("use", "sig") == "sig":
                keys[jwk["kid"]] = RSAAlgorithm.from_jwk(json.dumps(jwk))
        if not keys:
            raise ValueError("the key set has no usable RSA signing keys")
        self._keys, self._fetched_at = keys, self.clock()

    def _key_for(self, kid: str) -> Any:
        with self._lock:
            now = self.clock()
            fresh = self._fetched_at is not None and now - self._fetched_at < KEY_TTL_S
            key = self._keys.get(kid) if fresh else None
            if key is not None:
                return key
            if self._last_attempt is None or now - self._last_attempt >= UNKNOWN_KID_REFETCH_S:
                try:
                    self._refresh()
                except Exception as e:  # network, bad JSON, bad keys
                    log.warning("could not fetch DINO's signing keys from %s: %s", self.cfg.jwks_url, e)
                    key = self._keys.get(kid)  # an old key beats locking everyone out during a short outage
                    if key is not None:
                        return key
                    raise ApiError(503, "sso_unavailable", "Sign-in with DINO is not reachable right now. Try again in a minute.") from e
            key = self._keys.get(kid)
            if key is None:
                raise ApiError(401, "unauthorized", "That sign-in token was not signed by DINO.")
            return key

    def user_id(self, token: str) -> str:
        """The DINO user ID for a valid token, else ApiError 401/403/503."""
        bad = ApiError(401, "unauthorized", "That sign-in token is not valid or has expired. Sign in again.")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise bad from None
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) \
                or str(header.get("typ", "")).lower() not in ("at+jwt", "application/at+jwt"):
            log.warning("sign-in token refused: header is not an RS256 at+jwt with a kid (alg=%s typ=%s)", header.get("alg"), header.get("typ"))
            raise bad
        key = self._key_for(header["kid"])
        try:
            claims = jwt.decode(
                token, key, algorithms=["RS256"], audience=self.cfg.sso_audience, issuer=self.cfg.sso_issuer,
                leeway=LEEWAY_S, options={"require": ["exp", "nbf", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError as e:
            log.warning("sign-in token refused: %s (%s). The token says %s; this server expects iss=%r aud=%r",
                        type(e).__name__, e, _peek(token), self.cfg.sso_issuer, self.cfg.sso_audience)
            raise bad from None
        if claims.get("client_id") != self.cfg.sso_client_id:
            log.warning("sign-in token refused: client_id is %r but this server accepts only %r (MAP_SSO_CLIENT_ID)",
                        claims.get("client_id"), self.cfg.sso_client_id)
            raise bad
        sub = claims["sub"]
        if not isinstance(sub, str) or not 0 < len(sub) <= 64 or not set(sub) <= ID_OK:
            log.warning("sign-in token refused: the subject is not a plain ID of 1 to 64 letters, digits, _ or -")
            raise bad
        roles = claims.get("roles")
        have = {r.strip().lower() for r in roles if isinstance(r, str)} if isinstance(roles, list) else set()
        if not have & KNOWN_ROLES:
            log.warning("sign-in token refused: no role this app knows (roles=%s)", sorted(have))
            raise ApiError(403, "forbidden", "Your DINO account does not have a role that can use the map editor.")
        return sub
