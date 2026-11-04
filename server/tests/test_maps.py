from conftest import auth, good_doc


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_needs_sign_in(client):
    assert client.get("/api/v1/maps").status_code == 401
    assert client.post("/api/v1/maps", json={"doc": good_doc()}).status_code == 401


def test_create_list_open_update_delete(client, dino):
    h = auth(dino.token("pupil_1"))
    r = client.post("/api/v1/maps", json={"doc": good_doc("Siege")}, headers=h)
    assert r.status_code == 201
    mid, v = r.json()["id"], r.json()["version"]
    assert v == 1

    listing = client.get("/api/v1/maps", headers=h).json()
    assert [(m["id"], m["title"], m["version"]) for m in listing] == [(mid, "Siege", 1)]
    assert "doc" not in listing[0]

    got = client.get(f"/api/v1/maps/{mid}", headers=h).json()
    assert got["doc"] == good_doc("Siege") and got["title"] == "Siege"

    r = client.put(f"/api/v1/maps/{mid}", json={"doc": good_doc("Siege 2"), "baseVersion": 1}, headers=h)
    assert r.status_code == 200 and r.json()["version"] == 2
    assert client.get(f"/api/v1/maps/{mid}", headers=h).json()["title"] == "Siege 2"

    assert client.delete(f"/api/v1/maps/{mid}", headers=h).status_code == 204
    assert client.get(f"/api/v1/maps/{mid}", headers=h).status_code == 404
    assert client.get("/api/v1/maps", headers=h).json() == []


def test_stale_save_is_a_conflict_and_changes_nothing(client, dino):
    h = auth(dino.token())
    mid = client.post("/api/v1/maps", json={"doc": good_doc("A")}, headers=h).json()["id"]
    client.put(f"/api/v1/maps/{mid}", json={"doc": good_doc("B"), "baseVersion": 1}, headers=h)
    r = client.put(f"/api/v1/maps/{mid}", json={"doc": good_doc("C"), "baseVersion": 1}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "conflict"
    assert client.get(f"/api/v1/maps/{mid}", headers=h).json()["title"] == "B"
    # Without a baseVersion the save simply wins.
    assert client.put(f"/api/v1/maps/{mid}", json={"doc": good_doc("D")}, headers=h).status_code == 200


def test_pupils_only_ever_see_their_own_maps(client, dino):
    a, b = auth(dino.token("ada")), auth(dino.token("bob", roles=("teacher",)))
    mid = client.post("/api/v1/maps", json={"doc": good_doc()}, headers=a).json()["id"]
    assert client.get("/api/v1/maps", headers=b).json() == []
    assert client.get(f"/api/v1/maps/{mid}", headers=b).status_code == 404
    assert client.put(f"/api/v1/maps/{mid}", json={"doc": good_doc("stolen")}, headers=b).status_code == 404
    assert client.delete(f"/api/v1/maps/{mid}", headers=b).status_code == 404
    assert client.get(f"/api/v1/maps/{mid}", headers=a).json()["title"] == "My map"


def test_limit_per_user(client, dino):
    h = auth(dino.token())
    for _ in range(3):
        assert client.post("/api/v1/maps", json={"doc": good_doc()}, headers=h).status_code == 201
    r = client.post("/api/v1/maps", json={"doc": good_doc()}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "too_many_maps"
    # Another person has their own allowance.
    assert client.post("/api/v1/maps", json={"doc": good_doc()}, headers=auth(dino.token("other"))).status_code == 201


def test_bad_maps_are_refused(client, dino):
    h = auth(dino.token())
    bad = [
        {"version": 3, "features": [], "objectives": []},
        {"version": 2, "features": "no", "objectives": []},
        good_doc(features=[{"type": "lava", "points": []}]),
        good_doc(features=[{"type": "hill", "points": [[1, "x"]]}]),
        good_doc(features=[{"type": "hill", "points": [[1e9, 0]]}]),
        good_doc(objectives=[{"x": True, "y": 1}]),
        good_doc(title="x" * 201),
        good_doc(grid="yes"),
    ]
    for d in bad:
        r = client.post("/api/v1/maps", json={"doc": d}, headers=h)
        assert r.status_code == 422, d
    assert client.post("/api/v1/maps", json={"doc": "text"}, headers=h).status_code == 422
    assert client.get("/api/v1/maps", headers=h).json() == []


def test_v1_files_are_accepted(client, dino):
    d = {"version": 1, "title": "Old", "rules": "", "seed": 1, "features": [], "objectives": []}
    assert client.post("/api/v1/maps", json={"doc": d}, headers=auth(dino.token())).status_code == 201


def test_oversized_map_is_refused(client, dino):
    h = auth(dino.token())
    big = good_doc(features=[{"id": str(i), "type": "road", "points": [[1, 1], [2, 2]]} for i in range(600)])
    r = client.post("/api/v1/maps", json={"doc": big}, headers=h)
    assert r.status_code == 413
    huge = {"doc": good_doc(rules="x" * 30_000)}
    assert client.post("/api/v1/maps", json=huge, headers=h).status_code == 413


def test_empty_title_is_untitled(client, dino):
    h = auth(dino.token())
    client.post("/api/v1/maps", json={"doc": good_doc("   ")}, headers=h)
    assert client.get("/api/v1/maps", headers=h).json()[0]["title"] == "Untitled"


def test_serves_the_built_editor_next_to_the_api(cfg, dino, tmp_path):
    from fastapi.testclient import TestClient
    from mapserver.app import create_app
    from mapserver.auth import Verifier
    site = tmp_path / "dist"
    site.mkdir()
    (site / "index.html").write_text("<title>editor</title>")
    cfg.static_dir = str(site)
    c = TestClient(create_app(cfg, Verifier(cfg, fetch=lambda u: dino.jwks)))
    assert "<title>editor</title>" in c.get("/").text
    assert c.get("/api/v1/maps").status_code == 401  # the API still wins over the static mount
    assert c.get("/health").status_code == 200
