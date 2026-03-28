"""
ADJUTORIX AGENT — CORE / SNAPSHOT_STORE

Deterministic, content-addressed snapshot store.

Responsibilities:
- Persist immutable workspace snapshots
- Provide consistent read views (by snapshot_id)
- Enforce content-addressing (hash = identity)
- Support partial file retrieval with integrity guarantees
- Enable replay + verification

Hard invariants:
- Snapshots are immutable
- Same content => same snapshot_id
- No in-place mutation EVER
- Snapshot must be fully verifiable from stored hashes

This module is STORAGE-LOGIC ONLY (no patch logic, no state machine).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple, Optional, List

import hashlib
import threading


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FileEntry:
    path: str
    content: bytes
    hash: str


@dataclass(frozen=True)
class Snapshot:
    snapshot_id: str
    file_index: Tuple[Tuple[str, str], ...]  # (path, hash)


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_snapshot(file_index: List[Tuple[str, str]]) -> str:
    h = hashlib.sha256()
    for path, fh in sorted(file_index):
        h.update(path.encode())
        h.update(fh.encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# STORE
# ---------------------------------------------------------------------------


class SnapshotStore:
    """
    In-memory content-addressed snapshot store.

    Structure:
    - file_blobs: hash -> bytes
    - snapshots: snapshot_id -> Snapshot
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._file_blobs: Dict[str, bytes] = {}
        self._snapshots: Dict[str, Snapshot] = {}

    # ------------------------------------------------------------------
    # WRITE
    # ------------------------------------------------------------------

    def create_snapshot(self, files: List[Tuple[str, bytes]]) -> Snapshot:
        """
        Create snapshot from full workspace state.
        """
        with self._lock:
            file_index: List[Tuple[str, str]] = []

            for path, content in files:
                file_hash = _hash_bytes(content)
                self._file_blobs.setdefault(file_hash, content)
                file_index.append((path, file_hash))

            snapshot_id = _hash_snapshot(file_index)

            if snapshot_id in self._snapshots:
                return self._snapshots[snapshot_id]

            snap = Snapshot(
                snapshot_id=snapshot_id,
                file_index=tuple(sorted(file_index)),
            )

            self._snapshots[snapshot_id] = snap
            return snap

    # ------------------------------------------------------------------
    # READ
    # ------------------------------------------------------------------

    def get_snapshot(self, snapshot_id: str) -> Snapshot:
        with self._lock:
            snap = self._snapshots.get(snapshot_id)
            if not snap:
                raise RuntimeError(f"snapshot_not_found: {snapshot_id}")
            return snap

    def read_file(self, snapshot_id: str, path: str) -> bytes:
        with self._lock:
            snap = self.get_snapshot(snapshot_id)
            for p, h in snap.file_index:
                if p == path:
                    data = self._file_blobs.get(h)
                    if data is None:
                        raise RuntimeError(f"blob_missing: {h}")
                    # integrity check
                    if _hash_bytes(data) != h:
                        raise RuntimeError(f"blob_corrupt: {h}")
                    return data

            raise RuntimeError(f"file_not_found: {path}")

    def list_files(self, snapshot_id: str) -> Tuple[str, ...]:
        snap = self.get_snapshot(snapshot_id)
        return tuple(p for p, _ in snap.file_index)

    # ------------------------------------------------------------------
    # VERIFY
    # ------------------------------------------------------------------

    def verify_snapshot(self, snapshot_id: str) -> None:
        """
        Full integrity verification.
        """
        with self._lock:
            snap = self.get_snapshot(snapshot_id)

            rebuilt_index: List[Tuple[str, str]] = []

            for path, h in snap.file_index:
                blob = self._file_blobs.get(h)
                if blob is None:
                    raise RuntimeError(f"verify_fail: missing_blob: {h}")

                actual = _hash_bytes(blob)
                if actual != h:
                    raise RuntimeError(f"verify_fail: corrupt_blob: {h}")

                rebuilt_index.append((path, h))

            rebuilt_id = _hash_snapshot(rebuilt_index)
            if rebuilt_id != snapshot_id:
                raise RuntimeError("verify_fail: snapshot_hash_mismatch")

    # ------------------------------------------------------------------
    # DIFF SUPPORT
    # ------------------------------------------------------------------

    def diff_snapshots(self, a: str, b: str) -> Dict[str, str]:
        """
        Returns map path -> status: added|removed|modified|unchanged
        """
        snap_a = self.get_snapshot(a)
        snap_b = self.get_snapshot(b)

        map_a = dict(snap_a.file_index)
        map_b = dict(snap_b.file_index)

        result: Dict[str, str] = {}

        all_paths = set(map_a) | set(map_b)

        for p in all_paths:
            ha = map_a.get(p)
            hb = map_b.get(p)

            if ha is None:
                result[p] = "added"
            elif hb is None:
                result[p] = "removed"
            elif ha != hb:
                result[p] = "modified"
            else:
                result[p] = "unchanged"

        return result


# ---------------------------------------------------------------------------
# GLOBAL INSTANCE
# ---------------------------------------------------------------------------


_GLOBAL: Optional[SnapshotStore] = None
_LOCK = threading.Lock()


def get_snapshot_store() -> SnapshotStore:
    global _GLOBAL
    if _GLOBAL is None:
        with _LOCK:
            if _GLOBAL is None:
                _GLOBAL = SnapshotStore()
    return _GLOBAL


def create_snapshot(files: List[Tuple[str, bytes]]) -> Snapshot:
    return get_snapshot_store().create_snapshot(files)


def read_file(snapshot_id: str, path: str) -> bytes:
    return get_snapshot_store().read_file(snapshot_id, path)


def verify(snapshot_id: str) -> None:
    get_snapshot_store().verify_snapshot(snapshot_id)
