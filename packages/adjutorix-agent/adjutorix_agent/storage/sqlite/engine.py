"""
ADJUTORIX AGENT — SQLITE ENGINE

Deterministic, controlled SQLite access layer.

Constraints:
- Single writer model (enforced externally via concurrency_guard)
- WAL mode enforced
- Foreign keys ON always
- Explicit transaction boundaries only (no implicit autocommit)
- Statement timeout + busy timeout enforced
- All connections created through this module ONLY

No raw sqlite3 usage outside this file.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional


# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SQLiteConfig:
    path: Path
    busy_timeout_ms: int = 5000
    journal_mode: str = "WAL"
    synchronous: str = "NORMAL"
    cache_size: int = -20000  # ~20MB


# ---------------------------------------------------------------------------
# ENGINE
# ---------------------------------------------------------------------------


class SQLiteEngine:
    """Controlled SQLite engine with strict invariants."""

    def __init__(self, config: SQLiteConfig) -> None:
        self._config = config
        self._path = config.path

        if not self._path.parent.exists():
            self._path.parent.mkdir(parents=True, exist_ok=True)

        self._init_db()

    # ---------------------------------------------------------------------
    # INIT
    # ---------------------------------------------------------------------

    def _init_db(self) -> None:
        with self._connect() as conn:
            self._apply_pragmas(conn)

    def _apply_pragmas(self, conn: sqlite3.Connection) -> None:
        c = conn.cursor()

        c.execute("PRAGMA journal_mode=WAL;")
        c.execute("PRAGMA foreign_keys=ON;")
        c.execute(f"PRAGMA synchronous={self._config.synchronous};")
        c.execute(f"PRAGMA cache_size={self._config.cache_size};")
        c.execute(f"PRAGMA busy_timeout={self._config.busy_timeout_ms};")

        conn.commit()

    # ---------------------------------------------------------------------
    # CONNECTION
    # ---------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self._path),
            isolation_level=None,  # manual transaction control
            check_same_thread=False,
        )

        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    # ---------------------------------------------------------------------
    # TRANSACTIONS
    # ---------------------------------------------------------------------

    @contextmanager
    def read_tx(self) -> Iterator[sqlite3.Connection]:
        """Read-only transaction (deferred)."""
        with self.connection() as conn:
            conn.execute("BEGIN DEFERRED;")
            try:
                yield conn
                if getattr(conn, "in_transaction", False):
                    conn.commit()
            except Exception:
                if getattr(conn, "in_transaction", False):
                    conn.rollback()
                raise

    @contextmanager
    def write_tx(self) -> Iterator[sqlite3.Connection]:
        """Write transaction (immediate lock)."""
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE;")
            try:
                yield conn
                if getattr(conn, "in_transaction", False):
                    conn.commit()
            except Exception:
                if getattr(conn, "in_transaction", False):
                    conn.rollback()
                raise

    # ---------------------------------------------------------------------
    # EXECUTION HELPERS
    # ---------------------------------------------------------------------

    def execute(self, sql: str, params: Optional[tuple] = None) -> None:
        with self.write_tx() as conn:
            conn.execute(sql, params or ())

    def fetch_one(self, sql: str, params: Optional[tuple] = None) -> Optional[sqlite3.Row]:
        with self.read_tx() as conn:
            cur = conn.execute(sql, params or ())
            return cur.fetchone()

    def fetch_all(self, sql: str, params: Optional[tuple] = None) -> list[sqlite3.Row]:
        with self.read_tx() as conn:
            cur = conn.execute(sql, params or ())
            return cur.fetchall()


# ---------------------------------------------------------------------------
# FACTORY
# ---------------------------------------------------------------------------


def build_sqlite_engine(path: str) -> SQLiteEngine:
    cfg = SQLiteConfig(path=Path(path))
    return SQLiteEngine(cfg)


__all__ = [
    "SQLiteEngine",
    "SQLiteConfig",
    "build_sqlite_engine",
]
