import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from mapserver.app import create_app
from mapserver.auth import Verifier
from mapserver.config import Settings

ISSUER = "https://dino.test"


class Dino:
    """A fake DINO: an RSA key, its JWKS, and a way to mint access tokens."""

    def __init__(self, kid="k1"):
        self.kid = kid
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.jwks = {"keys": [{**json.loads(RSAAlgorithm.to_jwk(self.key.public_key())), "kid": kid, "use": "sig", "alg": "RS256"}]}

    def token(self, sub="u1", roles=("pupil",), **over):
        now = int(time.time())
        claims = {"iss": ISSUER, "aud": "kerf-sabre", "sub": sub, "client_id": "map-editor", "roles": list(roles),
                  "iat": now, "nbf": now, "exp": now + 900}
        claims.update(over)
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": self.kid, "typ": "at+jwt"})


@pytest.fixture
def dino():
    return Dino()


@pytest.fixture
def cfg(tmp_path):
    return Settings(sso_issuer=ISSUER, db_path=str(tmp_path / "maps.db"), max_maps_per_user=3, max_doc_bytes=20_000)


@pytest.fixture
def client(cfg, dino):
    v = Verifier(cfg, fetch=lambda url: dino.jwks)
    return TestClient(create_app(cfg, v))


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def good_doc(title="My map", **over):
    d = {"version": 3, "background": "#e9dfc7", "title": title, "rules": "Hold the middle.", "seed": 1, "grid": True,
         "features": [{"id": "a", "type": "hill", "points": [[10, 10], [60, 10], [40, 50]]},
                      {"id": "b", "type": "wall", "points": [[0, 0], [100, 0], [100, 80]]}],
         "objectives": [{"id": "o", "x": 50, "y": 50, "label": "1"}]}
    d.update(over)
    return d
