"""
ADJUTORIX AGENT — SQLITE MIGRATIONS

Deterministic, idempotent schema migrations.

Properties:
- Linear, ordered migrations (no branching)
- Each migration is atomic (single transaction)
- Checksums stored to prevent drift
- Re-entrant: safe to run on every boot
- Strict failure on checksum mismatch

Tables:
- _migrations(version INTEGER PK, name TEXT, checksum TEXT, applied_at INTEGER)
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Callable, List

from .engine import SQLiteEngine


# ---------------------------------------------------------------------------
# MODEL
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[["SQLiteEngine"], None]

    def checksum(self) -> str:
        src = f"{self.version}:{self.name}:{self.apply.__code__.co_code}"
        return hashlib.sha256(src.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# MIGRATIONS
# ---------------------------------------------------------------------------


def _m0001_create_base(engine: SQLiteEngine) -> None:
    with engine.write_tx() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ledger_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tx_id TEXT UNIQUE NOT NULL,
                seq INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ledger_artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                artifact_id TEXT UNIQUE NOT NULL,
                kind TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ledger_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_artifact TEXT NOT NULL,
                to_artifact TEXT NOT NULL,
                edge_type TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tx_seq ON ledger_transactions(seq);
            CREATE INDEX IF NOT EXISTS idx_edges_from ON ledger_edges(from_artifact);
            CREATE INDEX IF NOT EXISTS idx_edges_to ON ledger_edges(to_artifact);
            """
        )


def _m0002_tx_store(engine: SQLiteEngine) -> None:
    with engine.write_tx() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tx_id TEXT UNIQUE NOT NULL,
                state TEXT NOT NULL,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id TEXT UNIQUE NOT NULL,
                root_path TEXT NOT NULL,
                file_count INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
        )


MIGRATIONS: List[Migration] = [
    Migration(1, "create_base", _m0001_create_base),
    Migration(2, "tx_store", _m0002_tx_store),
]


# ---------------------------------------------------------------------------
# ENGINE HOOKS
# ---------------------------------------------------------------------------


def ensure_migration_table(engine: SQLiteEngine) -> None:
    with engine.write_tx() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            );
            """
        )


def get_applied(engine: SQLiteEngine) -> dict[int, tuple[str, str]]:
    with engine.read_tx() as conn:
        rows = conn.execute("SELECT version, name, checksum FROM _migrations").fetchall()
        return {int(r[0]): (str(r[1]), str(r[2])) for r in rows}


def record_applied(engine: SQLiteEngine, m: Migration) -> None:
    with engine.write_tx() as conn:
        conn.execute(
            "INSERT INTO _migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
            (m.version, m.name, m.checksum(), int(time.time() * 1_000_000)),
        )


# ---------------------------------------------------------------------------
# RUNNER
# ---------------------------------------------------------------------------


def apply_migrations(engine: SQLiteEngine) -> None:
    ensure_migration_table(engine)

    applied = get_applied(engine)

    for m in sorted(MIGRATIONS, key=lambda x: x.version):
        existing = applied.get(m.version)

        if existing is not None:
            name, checksum = existing
            if name != m.name or checksum != m.checksum():
                raise RuntimeError(
                    f"Migration checksum mismatch at v{m.version}: existing=({name},{checksum}) new=({m.name},{m.checksum()})"
                )
            continue

        # apply
        m.apply(engine)
        record_applied(engine, m)


__all__ = [
    "Migration",
    "MIGRATIONS",
    "apply_migrations",
]
