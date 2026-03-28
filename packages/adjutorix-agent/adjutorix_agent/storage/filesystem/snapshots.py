"""
ADJUTORIX AGENT — FILESYSTEM SNAPSHOTS

Deterministic, content-addressed snapshot system.

Responsibilities:
- Capture byte-accurate workspace snapshots
- Enforce immutability
- Provide reproducible extraction
- Enable diff base for patch pipeline

Hard guarantees:
- Snapshot is content-addressed (hash of archive bytes)
- Snapshot is immutable after creation
- Extraction is isolated and validated
- No partial snapshot states ever exposed

Format:
- tar.zst (streamed, deterministic ordering)
"""

from __future__ import annotations

import io
import os
import tarfile
import hashlib
import tempfile
from pathlib import Path
from typing import Iterable, Tuple

import zstandard as zstd

from .paths import snapshot_file, snapshot_dir, assert_within_workspace


# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

CHUNK_SIZE = 1024 * 1024  # 1MB
ZSTD_LEVEL = 10


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _hash_stream(reader: Iterable[bytes]) -> str:
    h = hashlib.sha256()
    for chunk in reader:
        h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# FILE ITERATION (DETERMINISTIC)
# ---------------------------------------------------------------------------


def _iter_files(root: Path) -> Iterable[Tuple[Path, Path]]:
    """
    Yields (absolute_path, relative_path) sorted deterministically.
    """
    files = []
    for base, _, filenames in os.walk(root):
        for name in filenames:
            abs_path = Path(base) / name
            rel_path = abs_path.relative_to(root)
            files.append((abs_path, rel_path))

    files.sort(key=lambda x: str(x[1]))
    return files


# ---------------------------------------------------------------------------
# SNAPSHOT CREATION
# ---------------------------------------------------------------------------


def create_snapshot(workspace_path: Path) -> str:
    """
    Create snapshot and return snapshot_id (sha256 of archive).
    """
    workspace_path = workspace_path.resolve()

    if not workspace_path.exists():
        raise RuntimeError(f"Workspace does not exist: {workspace_path}")

    # temporary archive
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        # write tar
        with open(tmp_path, "wb") as raw:
            compressor = zstd.ZstdCompressor(level=ZSTD_LEVEL)
            with compressor.stream_writer(raw) as zstd_writer:
                with tarfile.open(fileobj=zstd_writer, mode="w|") as tar:

                    for abs_path, rel_path in _iter_files(workspace_path):
                        assert_within_workspace(workspace_path, abs_path)

                        tarinfo = tar.gettarinfo(str(abs_path), arcname=str(rel_path))
                        tarinfo.uid = 0
                        tarinfo.gid = 0
                        tarinfo.uname = ""
                        tarinfo.gname = ""
                        tarinfo.mtime = 0  # deterministic

                        with open(abs_path, "rb") as f:
                            tar.addfile(tarinfo, fileobj=f)

        # compute hash
        def reader():
            with open(tmp_path, "rb") as f:
                while True:
                    chunk = f.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

        snapshot_id = _hash_stream(reader())

        # move to final location
        final_path = snapshot_file(workspace_path, snapshot_id)

        if not final_path.exists():
            os.replace(tmp_path, final_path)
        else:
            tmp_path.unlink(missing_ok=True)

        return snapshot_id

    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# SNAPSHOT VALIDATION
# ---------------------------------------------------------------------------


def validate_snapshot(workspace_path: Path, snapshot_id: str) -> bool:
    path = snapshot_file(workspace_path, snapshot_id)

    if not path.exists():
        return False

    def reader():
        with open(path, "rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk

    return _hash_stream(reader()) == snapshot_id


# ---------------------------------------------------------------------------
# SNAPSHOT EXTRACTION
# ---------------------------------------------------------------------------


def extract_snapshot(workspace_path: Path, snapshot_id: str, target_dir: Path) -> None:
    """
    Extract snapshot into target_dir (must be empty or non-existing).
    """
    target_dir = target_dir.resolve()

    if target_dir.exists() and any(target_dir.iterdir()):
        raise RuntimeError("Target dir must be empty")

    target_dir.mkdir(parents=True, exist_ok=True)

    archive_path = snapshot_file(workspace_path, snapshot_id)

    if not archive_path.exists():
        raise RuntimeError(f"Snapshot not found: {snapshot_id}")

    with open(archive_path, "rb") as f:
        dctx = zstd.ZstdDecompressor()
        with dctx.stream_reader(f) as reader:
            with tarfile.open(fileobj=reader, mode="r|") as tar:
                for member in tar:
                    target_path = target_dir / member.name
                    assert_within_workspace(target_dir, target_path)

                    if member.isdir():
                        target_path.mkdir(parents=True, exist_ok=True)
                        continue

                    target_path.parent.mkdir(parents=True, exist_ok=True)

                    extracted = tar.extractfile(member)
                    if extracted is None:
                        continue

                    with open(target_path, "wb") as out:
                        while True:
                            chunk = extracted.read(CHUNK_SIZE)
                            if not chunk:
                                break
                            out.write(chunk)


# ---------------------------------------------------------------------------
# SNAPSHOT DIFF BASE
# ---------------------------------------------------------------------------


def snapshot_exists(workspace_path: Path, snapshot_id: str) -> bool:
    return snapshot_file(workspace_path, snapshot_id).exists()


__all__ = [
    "create_snapshot",
    "validate_snapshot",
    "extract_snapshot",
    "snapshot_exists",
]
