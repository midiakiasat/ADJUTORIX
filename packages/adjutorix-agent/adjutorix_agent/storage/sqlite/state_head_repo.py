"""
ADJUTORIX AGENT — STATE HEAD REPOSITORY

Canonical persistence for CURRENT STATE HEADS.

Concept:
- State heads define the *authoritative tip* of each logical state domain
- Examples: workspace_head, ledger_head, index_head
- There is EXACTLY ONE head per domain

Properties:
- Strong consistency (single row per domain)
- Monotonic progression enforced (seq must increase)
- No silent overwrite (conflicts must fail)
- Deterministic reads

Table (must exist via migrations extension):

CREATE TABLE state_heads (
    domain TEXT PRIMARY KEY,
    ref_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_state_heads_domain ON state_heads(domain);
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, List
import time

from .engine import SQLiteEngine


# ---------------------------------------------------------------------------
# MODEL
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StateHead:
    domain: str
    ref_id: str
    seq: int
    updated_at: int


# ---------------------------------------------------------------------------
# MAPPER
# ---------------------------------------------------------------------------


def _map(row) -> StateHead:
    return StateHead(
        domain=row["domain"],
        ref_id=row["ref_id"],
        seq=row["seq"],
        updated_at=row["updated_at"],
    )


# ---------------------------------------------------------------------------
# REPOSITORY
# ---------------------------------------------------------------------------


class StateHeadRepository:
    def __init__(self, engine: SQLiteEngine) -> None:
        self._engine = engine

    # ---------------------------------------------------------------------
    # CREATE / INIT
    # ---------------------------------------------------------------------

    def initialize(self, domain: str, ref_id: str, seq: int) -> None:
        """
        Initialize a domain head. Fails if already exists.
        """
        now = int(time.time() * 1_000_000)

        with self._engine.write_tx() as conn:
            conn.execute(
                """
                INSERT INTO state_heads (domain, ref_id, seq, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (domain, ref_id, seq, now),
            )

    # ---------------------------------------------------------------------
    # UPDATE (MONOTONIC)
    # ---------------------------------------------------------------------

    def advance(self, domain: str, new_ref_id: str, new_seq: int) -> None:
        """
        Advance head strictly forward.
        Enforces monotonic seq.
        """
        now = int(time.time() * 1_000_000)

        with self._engine.write_tx() as conn:
            row = conn.execute(
                "SELECT seq FROM state_heads WHERE domain = ?",
                (domain,),
            ).fetchone()

            if row is None:
                raise RuntimeError(f"State head not initialized: {domain}")

            current_seq = int(row[0])

            if new_seq <= current_seq:
                raise RuntimeError(
                    f"Non-monotonic state advance: {domain} current={current_seq} new={new_seq}"
                )

            conn.execute(
                """
                UPDATE state_heads
                SET ref_id = ?, seq = ?, updated_at = ?
                WHERE domain = ?
                """,
                (new_ref_id, new_seq, now, domain),
            )

    # ---------------------------------------------------------------------
    # READ
    # ---------------------------------------------------------------------

    def get(self, domain: str) -> Optional[StateHead]:
        row = self._engine.fetch_one(
            "SELECT * FROM state_heads WHERE domain = ?",
            (domain,),
        )
        return _map(row) if row else None

    def list_all(self) -> List[StateHead]:
        rows = self._engine.fetch_all(
            "SELECT * FROM state_heads ORDER BY domain ASC"
        )
        return [_map(r) for r in rows]

    # ---------------------------------------------------------------------
    # INVARIANTS
    # ---------------------------------------------------------------------

    def assert_exists(self, domain: str) -> None:
        if self.get(domain) is None:
            raise RuntimeError(f"Invariant violation: state head missing {domain}")

    def assert_seq(self, domain: str, expected_seq: int) -> None:
        head = self.get(domain)
        if head is None:
            raise RuntimeError(f"State head not found: {domain}")
        if head.seq != expected_seq:
            raise RuntimeError(
                f"State head seq mismatch: {domain} expected={expected_seq} actual={head.seq}"
            )


__all__ = [
    "StateHead",
    "StateHeadRepository",
]
