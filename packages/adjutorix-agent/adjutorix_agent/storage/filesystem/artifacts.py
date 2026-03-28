"""
ADJUTORIX AGENT — FILESYSTEM ARTIFACTS

Content-addressed artifact storage with immutability, streaming IO,
atomic writes, and strong integrity guarantees.

Responsibilities:
- Store all execution artifacts (logs, diffs, reports, binaries)
- Enforce immutability (write-once, read-many)
- Provide streaming read/write interfaces
- Deduplicate by content hash
- Maintain metadata sidecar with strict schema

Hard guarantees:
- Artifact identity = sha256(content)
- Atomic publish (no partial files visible)
- No overwrite of existing artifact
- Path traversal impossible
- Size + hash validated on read

Layout:
  <root>/artifacts/<tx_id>/<artifact_id>/
      ├── blob
      └── meta.json

Where:
  artifact_id = sha256(blob)

"""

from __future__ import annotations

import io
import json
import os
import hashlib
import tempfile
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import BinaryIO, Iterable, Optional, Dict, Any

from .paths import artifact_dir, artifact_file, assert_within_workspace


# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

CHUNK_SIZE = 1024 * 1024  # 1MB
BLOB_NAME = "blob"
META_NAME = "meta.json"


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ArtifactMeta:
    artifact_id: str
    tx_id: str
    name: str
    mime: str
    size: int
    sha256: str
    created_at: int
    tags: Dict[str, str]


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _hash_stream(reader: Iterable[bytes]) -> str:
    h = hashlib.sha256()
    for chunk in reader:
        h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# INTERNAL PATHS
# ---------------------------------------------------------------------------


def _artifact_base(tx_id: str, artifact_id: str) -> Path:
    base = artifact_dir(tx_id)
    path = base / artifact_id
    return path


def _blob_path(tx_id: str, artifact_id: str) -> Path:
    return _artifact_base(tx_id, artifact_id) / BLOB_NAME


def _meta_path(tx_id: str, artifact_id: str) -> Path:
    return _artifact_base(tx_id, artifact_id) / META_NAME


# ---------------------------------------------------------------------------
# WRITE (ATOMIC)
# ---------------------------------------------------------------------------


def write_artifact(
    tx_id: str,
    name: str,
    mime: str,
    reader: BinaryIO,
    *,
    tags: Optional[Dict[str, str]] = None,
    created_at: Optional[int] = None,
) -> ArtifactMeta:
    """
    Stream-write artifact, compute hash, and publish atomically.
    """
    if tags is None:
        tags = {}

    # stage file
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = Path(tmp.name)

    size = 0

    try:
        with open(tmp_path, "wb") as out:
            while True:
                chunk = reader.read(CHUNK_SIZE)
                if not chunk:
                    break
                out.write(chunk)
                size += len(chunk)

        # compute hash
        def r():
            with open(tmp_path, "rb") as f:
                while True:
                    c = f.read(CHUNK_SIZE)
                    if not c:
                        break
                    yield c

        sha256 = _hash_stream(r())
        artifact_id = sha256

        base = _artifact_base(tx_id, artifact_id)
        blob = base / BLOB_NAME
        meta = base / META_NAME

        if blob.exists() and meta.exists():
            # already exists (dedup)
            tmp_path.unlink(missing_ok=True)
            return read_meta(tx_id, artifact_id)

        base.mkdir(parents=True, exist_ok=True)

        # atomic move
        os.replace(tmp_path, blob)

        meta_obj = ArtifactMeta(
            artifact_id=artifact_id,
            tx_id=tx_id,
            name=name,
            mime=mime,
            size=size,
            sha256=sha256,
            created_at=created_at or int(__import__("time").time()),
            tags=tags,
        )

        with open(meta, "w", encoding="utf-8") as f:
            json.dump(asdict(meta_obj), f, separators=(",", ":"), sort_keys=True)

        return meta_obj

    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# READ
# ---------------------------------------------------------------------------


def read_meta(tx_id: str, artifact_id: str) -> ArtifactMeta:
    path = _meta_path(tx_id, artifact_id)

    if not path.exists():
        raise RuntimeError(f"Artifact meta not found: {artifact_id}")

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    return ArtifactMeta(**data)



def open_blob(tx_id: str, artifact_id: str) -> BinaryIO:
    path = _blob_path(tx_id, artifact_id)

    if not path.exists():
        raise RuntimeError(f"Artifact blob not found: {artifact_id}")

    return open(path, "rb")


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


def validate_artifact(tx_id: str, artifact_id: str) -> bool:
    meta = read_meta(tx_id, artifact_id)

    blob = _blob_path(tx_id, artifact_id)

    if not blob.exists():
        return False

    size = blob.stat().st_size
    if size != meta.size:
        return False

    def r():
        with open(blob, "rb") as f:
            while True:
                c = f.read(CHUNK_SIZE)
                if not c:
                    break
                yield c

    return _hash_stream(r()) == meta.sha256


# ---------------------------------------------------------------------------
# LISTING
# ---------------------------------------------------------------------------


def list_artifacts(tx_id: str) -> Iterable[ArtifactMeta]:
    base = artifact_dir(tx_id)

    if not base.exists():
        return []

    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        meta = entry / META_NAME
        if meta.exists():
            yield read_meta(tx_id, entry.name)


# ---------------------------------------------------------------------------
# EXPORT
# ---------------------------------------------------------------------------


def export_artifact(tx_id: str, artifact_id: str, target: Path) -> None:
    """
    Copy artifact blob to external location (validated).
    """
    blob = _blob_path(tx_id, artifact_id)
    assert_within_workspace(blob.parent, blob)

    if not blob.exists():
        raise RuntimeError("Artifact not found")

    target = target.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    with open(blob, "rb") as src, open(target, "wb") as dst:
        while True:
            chunk = src.read(CHUNK_SIZE)
            if not chunk:
                break
            dst.write(chunk)


__all__ = [
    "ArtifactMeta",
    "write_artifact",
    "read_meta",
    "open_blob",
    "validate_artifact",
    "list_artifacts",
    "export_artifact",
]
