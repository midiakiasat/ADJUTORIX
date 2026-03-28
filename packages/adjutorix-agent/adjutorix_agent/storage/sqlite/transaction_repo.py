"""
ADJUTORIX AGENT — TRANSACTION REPOSITORY

Strict persistence layer for transaction state.

Properties:
- No business logic (state machine external)
- Atomic writes only
- Idempotent inserts
- Strong read consistency
- Explicit query surface (no generic ORM behavior)

Failure modes are explicit and never swallowed.
"""

from __future__ import annotations

from typing import Optional, List
import time

from .engine import SQLiteEngine
from .models import Transaction, map_transaction


# ---------------------------------------------------------------------------
# REPOSITORY
# ---------------------------------------------------------------------------


class TransactionRepository:
    def __init__(self, engine: SQLiteEngine) -> None:
        self._engine = engine

    # ---------------------------------------------------------------------
    # CREATE
    # ---------------------------------------------------------------------

    def create(self, tx_id: str, state: str) -> None:
        now = int(time.time() * 1_000_000)

        with self._engine.write_tx() as conn:
            conn.execute(
                """
                INSERT INTO transactions (tx_id, state, error, created_at, updated_at)
                VALUES (?, ?, NULL, ?, ?)
                """,
                (tx_id, state, now, now),
            )

    # ---------------------------------------------------------------------
    # UPDATE
    # ---------------------------------------------------------------------

    def update_state(self, tx_id: str, state: str, error: Optional[str] = None) -> None:
        now = int(time.time() * 1_000_000)

        with self._engine.write_tx() as conn:
            res = conn.execute(
                """
                UPDATE transactions
                SET state = ?, error = ?, updated_at = ?
                WHERE tx_id = ?
                """,
                (state, error, now, tx_id),
            )

            if res.rowcount == 0:
                raise RuntimeError(f"Transaction not found: {tx_id}")

    # ---------------------------------------------------------------------
    # READ
    # ---------------------------------------------------------------------

    def get(self, tx_id: str) -> Optional[Transaction]:
        row = self._engine.fetch_one(
            "SELECT * FROM transactions WHERE tx_id = ?",
            (tx_id,),
        )
        return map_transaction(row) if row else None

    def list_all(self, limit: int = 1000) -> List[Transaction]:
        rows = self._engine.fetch_all(
            "SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        return [map_transaction(r) for r in rows]

    # ---------------------------------------------------------------------
    # INVARIANT CHECKS
    # ---------------------------------------------------------------------

    def assert_exists(self, tx_id: str) -> None:
        if self.get(tx_id) is None:
            raise RuntimeError(f"Invariant violation: transaction missing {tx_id}")

    def assert_state(self, tx_id: str, expected: str) -> None:
        tx = self.get(tx_id)
        if tx is None:
            raise RuntimeError(f"Transaction not found: {tx_id}")
        if tx.state != expected:
            raise RuntimeError(
                f"Invalid state for {tx_id}: expected={expected} actual={tx.state}"
            )


__all__ = ["TransactionRepository"]
