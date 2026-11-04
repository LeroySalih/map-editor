"""SQLite storage. One row per map, owned by a DINO user ID. A connection per call keeps threads simple."""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS maps_owner ON maps (owner, updated_at DESC);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        self.path = path
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        try:
            with c:  # commit or roll back
                yield c
        finally:
            c.close()

    def count(self, owner: str) -> int:
        with self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM maps WHERE owner=?", (owner,)).fetchone()[0]

    def list(self, owner: str) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT id,title,version,updated_at FROM maps WHERE owner=? ORDER BY updated_at DESC, id", (owner,)).fetchall()
        return [{"id": r["id"], "title": r["title"], "version": r["version"], "updatedAt": r["updated_at"]} for r in rows]

    def create(self, owner: str, title: str, doc: dict[str, Any]) -> dict[str, Any]:
        mid, t = uuid.uuid4().hex, now()
        with self._conn() as c:
            c.execute("INSERT INTO maps VALUES (?,?,?,?,?,?,?)", (mid, owner, title, json.dumps(doc), 1, t, t))
        return {"id": mid, "version": 1, "updatedAt": t}

    def get(self, owner: str, mid: str) -> dict[str, Any] | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM maps WHERE id=? AND owner=?", (mid, owner)).fetchone()
        if r is None:
            return None
        return {"id": r["id"], "title": r["title"], "version": r["version"], "updatedAt": r["updated_at"], "doc": json.loads(r["doc"])}

    def update(self, owner: str, mid: str, title: str, doc: dict[str, Any], base_version: int | None) -> dict[str, Any] | str | None:
        """The new {id, version, updatedAt}; "conflict" when base_version is not current; None when there is no such map."""
        t = now()
        with self._conn() as c:
            r = c.execute("SELECT version FROM maps WHERE id=? AND owner=?", (mid, owner)).fetchone()
            if r is None:
                return None
            if base_version is not None and base_version != r["version"]:
                return "conflict"
            v = r["version"] + 1
            c.execute("UPDATE maps SET title=?, doc=?, version=?, updated_at=? WHERE id=? AND owner=? AND version=?",
                      (title, json.dumps(doc), v, t, mid, owner, r["version"]))
        return {"id": mid, "version": v, "updatedAt": t}

    def delete(self, owner: str, mid: str) -> bool:
        with self._conn() as c:
            return c.execute("DELETE FROM maps WHERE id=? AND owner=?", (mid, owner)).rowcount > 0
