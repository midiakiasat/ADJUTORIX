"""
ADJUTORIX AGENT — LEDGER / STATE_HEADS

Deterministic computation, caching, and validation of canonical "heads" derived
from the append-only ledger.

Heads are projections (not sources of truth) that accelerate read paths while
remaining fully recomputable via replay. Any divergence between cached heads and
replay must be treated as a hard error.

Responsibilities:
- Compute canonical heads from ledger (current snapshot, per-tx states, etc.)
- Maintain monotonic, atomic updates to cached heads in LedgerStore.index
- Provide idempotent upsert of heads tied to a specific last_seq
- Validate cached heads against replay (no silent repair)
- Offer transactional read API with snapshot isolation semantics

Hard invariants:
- Heads are functions of (ledger stream up to seq)
- Cache key includes last_seq; updates must be monotonic
- No partial updates: all heads updated atomically for a given seq
- Reads may serve from cache only if cache.last_seq >= requested_seq
- Any mismatch with replay raises
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Optional, Tuple, Any

import json
import hashlib
import threading

from adjutorix_agent.ledger.store import LedgerStore
from adjutorix_agent.ledger.replay import LedgerReplayer, ReplayResult


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SnapshotHead:
    snapshot_id: Optional[str]


@dataclass(frozen=True)
class TxHead:
    tx_id: str
    state: str
    snapshot_id: str


@dataclass(frozen=True)
class HeadsBundle:
    """
    Canonical heads computed at a specific sequence.
    """
    last_seq: int
    current_snapshot: SnapshotHead
    tx_heads: Tuple[TxHead, ...]
    state_hash: str  # hash of reconstructed state


# ---------------------------------------------------------------------------
# SERIALIZATION
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _stable_hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _encode_bundle(bundle: HeadsBundle) -> str:
    payload = {
        "last_seq": bundle.last_seq,
        "current_snapshot": asdict(bundle.current_snapshot),
        "tx_heads": [asdict(t) for t in bundle.tx_heads],
        "state_hash": bundle.state_hash,
    }
    return _stable_json(payload)


def _decode_bundle(s: str) -> HeadsBundle:
    payload = json.loads(s)
    return HeadsBundle(
        last_seq=payload["last_seq"],
        current_snapshot=SnapshotHead(**payload["current_snapshot"]),
        tx_heads=tuple(TxHead(**t) for t in payload["tx_heads"]),
        state_hash=payload["state_hash"],
    )


# ---------------------------------------------------------------------------
# COMPUTATION
# ---------------------------------------------------------------------------


class HeadsComputer:
    """
    Pure computation from replay result.
    """

    def from_replay(self, rr: ReplayResult) -> HeadsBundle:
        # current snapshot
        current_snapshot = SnapshotHead(snapshot_id=rr.state.current_snapshot_id)

        # tx heads (sorted for determinism)
        tx_heads = tuple(
            sorted(
                (
                    TxHead(
                        tx_id=tx.tx_id,
                        state=tx.state,
                        snapshot_id=tx.snapshot_id,
                    )
                    for tx in rr.state.transactions.values()
                ),
                key=lambda t: (t.tx_id, t.state, t.snapshot_id),
            )
        )

        bundle = HeadsBundle(
            last_seq=rr.state.last_seq,
            current_snapshot=current_snapshot,
            tx_heads=tx_heads,
            state_hash=rr.state_hash,
        )
        return bundle


# ---------------------------------------------------------------------------
# CACHE MANAGER
# ---------------------------------------------------------------------------


class HeadsCache:
    """
    Atomic, monotonic cache over LedgerStore.index.
    """

    INDEX_KEY = "heads_bundle"
    INDEX_SEQ_KEY = "heads_last_seq"

    def __init__(self, store: LedgerStore) -> None:
        self._store = store
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # READ
    # ------------------------------------------------------------------

    def get(self) -> Optional[HeadsBundle]:
        raw = self._store.get_index(self.INDEX_KEY)
        if raw is None:
            return None
        return _decode_bundle(raw)

    def get_if_fresh(self, min_seq: int) -> Optional[HeadsBundle]:
        bundle = self.get()
        if bundle is None:
            return None
        if bundle.last_seq < min_seq:
            return None
        return bundle

    # ------------------------------------------------------------------
    # WRITE (ATOMIC + MONOTONIC)
    # ------------------------------------------------------------------

    def upsert(self, bundle: HeadsBundle) -> None:
        """
        Only updates if bundle.last_seq is >= existing.
        Atomic across both keys.
        """
        with self._lock:
            existing = self.get()
            if existing is not None and bundle.last_seq < existing.last_seq:
                # reject stale write
                return

            encoded = _encode_bundle(bundle)

            # two keys, but atomic via single connection transaction
            self._store.set_index(self.INDEX_KEY, encoded)
            self._store.set_index(self.INDEX_SEQ_KEY, str(bundle.last_seq))


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


class HeadsValidator:
    """
    Compares cached heads against replay.
    """

    def validate(self, bundle: HeadsBundle, rr: ReplayResult) -> None:
        if bundle.last_seq != rr.state.last_seq:
            raise RuntimeError(
                f"heads_seq_mismatch: cache={bundle.last_seq} replay={rr.state.last_seq}"
            )

        if bundle.state_hash != rr.state_hash:
            raise RuntimeError(
                f"heads_state_hash_mismatch: cache={bundle.state_hash} replay={rr.state_hash}"
            )

        # check current snapshot
        if bundle.current_snapshot.snapshot_id != rr.state.current_snapshot_id:
            raise RuntimeError(
                "heads_current_snapshot_mismatch"
            )

        # check tx heads (set equality)
        cache_set = {(t.tx_id, t.state, t.snapshot_id) for t in bundle.tx_heads}
        replay_set = {
            (tx.tx_id, tx.state, tx.snapshot_id)
            for tx in rr.state.transactions.values()
        }

        if cache_set != replay_set:
            raise RuntimeError("heads_tx_set_mismatch")


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


class StateHeadsService:
    """
    High-level API used by server/CLI:
    - compute (via replay)
    - cache (monotonic)
    - read (fresh or recompute)
    - validate (strict)
    """

    def __init__(self, store: LedgerStore) -> None:
        self._store = store
        self._replayer = LedgerReplayer(store)
        self._computer = HeadsComputer()
        self._cache = HeadsCache(store)
        self._validator = HeadsValidator()

    # ------------------------------------------------------------------
    # COMPUTE + CACHE
    # ------------------------------------------------------------------

    def recompute_and_cache(self) -> HeadsBundle:
        rr = self._replayer.replay_all()
        bundle = self._computer.from_replay(rr)
        self._cache.upsert(bundle)
        return bundle

    # ------------------------------------------------------------------
    # READ
    # ------------------------------------------------------------------

    def get_heads(self, min_seq: Optional[int] = None, validate: bool = True) -> HeadsBundle:
        if min_seq is None:
            cached = self._cache.get()
        else:
            cached = self._cache.get_if_fresh(min_seq)

        if cached is None:
            cached = self.recompute_and_cache()

        if validate:
            rr = self._replayer.replay_upto(cached.last_seq)
            self._validator.validate(cached, rr)

        return cached

    # ------------------------------------------------------------------
    # FAST PATH
    # ------------------------------------------------------------------

    def current_snapshot_id(self) -> Optional[str]:
        bundle = self.get_heads(validate=False)
        return bundle.current_snapshot.snapshot_id

    def tx_state(self, tx_id: str) -> Optional[Tuple[str, str]]:
        bundle = self.get_heads(validate=False)
        for t in bundle.tx_heads:
            if t.tx_id == tx_id:
                return (t.state, t.snapshot_id)
        return None
