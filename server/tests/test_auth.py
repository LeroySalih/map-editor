import time

import jwt
import pytest
from fastapi.testclient import TestClient

from conftest import Dino, auth, good_doc
from mapserver.app import create_app
from mapserver.auth import Verifier


def status(client, token):
    return client.get("/api/v1/maps", headers=auth(token)).status_code


def test_valid_token_works(client, dino):
    assert status(client, dino.token()) == 200


@pytest.mark.parametrize("over", [
    {"aud": "someone-else"}, {"iss": "https://evil.test"}, {"client_id": "kerf-editor"}, {"client_id": None},
    {"exp": int(time.time()) - 3600}, {"nbf": int(time.time()) + 3600}, {"sub": None}, {"sub": "a b"}, {"sub": "x" * 65},
])
def test_bad_claims_are_refused(client, dino, over):
    assert status(client, dino.token(**over)) == 401


def test_role_is_needed(client, dino):
    assert status(client, dino.token(roles=())) == 403
    assert status(client, dino.token(roles=("student-of-something",))) == 403
    for role in ("pupil", "teacher", "admin", "technician"):
        assert status(client, dino.token(roles=(role,))) == 200


def test_only_rs256_signed_by_dino_is_accepted(client, dino):
    now = int(time.time())
    claims = {"iss": "https://dino.test", "aud": "kerf-sabre", "sub": "u1", "client_id": "map-editor", "roles": ["pupil"], "nbf": now, "exp": now + 900}
    other = Dino()  # a different key with the same key id
    assert status(client, other.token()) == 401
    assert status(client, jwt.encode(claims, "secret" * 8, algorithm="HS256", headers={"kid": "k1", "typ": "at+jwt"})) == 401
    unsigned = jwt.encode(claims, None, algorithm="none", headers={"kid": "k1", "typ": "at+jwt"})
    assert status(client, unsigned) == 401
    no_typ = jwt.encode(claims, dino.key, algorithm="RS256", headers={"kid": "k1"})
    assert status(client, no_typ) == 401
    assert status(client, "not-a-jwt") == 401
    assert client.get("/api/v1/maps", headers={"Authorization": "Basic abc"}).status_code == 401


def test_unknown_kid_is_refused(client, dino):
    d2 = Dino(kid="other")
    assert status(client, d2.token()) == 401


def test_dino_down_with_no_keys_is_503_but_cached_keys_keep_working(cfg, dino):
    calls = {"n": 0, "down": False}
    now = {"t": 0.0}

    def fetch(url):
        calls["n"] += 1
        if calls["down"]:
            raise OSError("dino is down")
        return dino.jwks

    v = Verifier(cfg, fetch=fetch, clock=lambda: now["t"])
    c = TestClient(create_app(cfg, v))
    calls["down"] = True
    assert status(c, dino.token()) == 503
    calls["down"] = False
    now["t"] = 100
    assert status(c, dino.token()) == 200
    n = calls["n"]
    assert status(c, dino.token()) == 200 and calls["n"] == n  # served from the cache
    calls["down"], now["t"] = True, 1000  # keys are stale and DINO is down: the old key still works
    assert status(c, dino.token()) == 200


def test_unknown_kid_does_not_hammer_dino(cfg, dino):
    calls = {"n": 0}

    def fetch(url):
        calls["n"] += 1
        return dino.jwks

    v = Verifier(cfg, fetch=fetch, clock=lambda: 0.0)
    c = TestClient(create_app(cfg, v))
    other = Dino(kid="nope")
    for _ in range(5):
        assert status(c, other.token()) == 401
    assert calls["n"] == 1


def test_no_secret_data_in_errors(client, dino):
    r = client.post("/api/v1/maps", json={"doc": good_doc()}, headers=auth("garbage"))
    assert r.status_code == 401 and "garbage" not in r.text
