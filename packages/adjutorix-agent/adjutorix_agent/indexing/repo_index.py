"""
ADJUTORIX AGENT — INDEXING / REPO_INDEX

Deterministic, content-addressed repository indexing engine.

Purpose:
- Build a complete, reproducible structural + content index of the workspace
- Support symbol_index, dependency_graph, references, diagnostics
- Enable fast queries with strong consistency guarantees

Key properties:
- Pure function of filesystem snapshot
- Stable ordering and hashing
- Incremental rebuild support (diff-aware)
- Language-agnostic core + pluggable analyzers

Hard invariants:
- Index must be reproducible from snapshot alone
- No hidden state or caching without hash anchoring
- Every indexed file has content_hash + metadata_hash
- Directory tree is canonicalized (sorted, normalized paths)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple, Optional, Iterable, Any

import hashlib
import json
import os


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


FileId = str
DirId = str


@dataclass(frozen=True)
class FileEntry:
    file_id: FileId
    rel_path: str
    size: int
    mtime_ns: int
    content_hash: str
    metadata_hash: str


@dataclass(frozen=True)
class DirEntry:
    dir_id: DirId
    rel_path: str
    children_files: Tuple[FileId, ...]
    children_dirs: Tuple[DirId, ...]


@dataclass(frozen=True)
class RepoIndex:
    root: str
    files: Tuple[FileEntry, ...]
    dirs: Tuple[DirEntry, ...]
    index_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _file_content_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# BUILDER
# ---------------------------------------------------------------------------


class RepoIndexBuilder:
    def __init__(self, root: str) -> None:
        self._root = os.path.abspath(root)

    # ------------------------------------------------------------------

    def build(self) -> RepoIndex:
        files: List[FileEntry] = []
        dirs: Dict[str, List[str]] = {}

        for dirpath, dirnames, filenames in os.walk(self._root):
            rel_dir = os.path.relpath(dirpath, self._root)
            if rel_dir == ".":
                rel_dir = ""

            dirs.setdefault(rel_dir, [])

            # deterministic ordering
            dirnames.sort()
            filenames.sort()

            for fname in filenames:
                abs_path = os.path.join(dirpath, fname)
                rel_path = os.path.join(rel_dir, fname) if rel_dir else fname

                st = os.stat(abs_path)
                content_hash = _file_content_hash(abs_path)

                meta_payload = {
                    "path": rel_path,
                    "size": st.st_size,
                    "mtime_ns": st.st_mtime_ns,
                }

                metadata_hash = _hash(meta_payload)
                file_id = _hash({"content": content_hash, "meta": metadata_hash})

                files.append(
                    FileEntry(
                        file_id=file_id,
                        rel_path=rel_path,
                        size=st.st_size,
                        mtime_ns=st.st_mtime_ns,
                        content_hash=content_hash,
                        metadata_hash=metadata_hash,
                    )
                )

                dirs[rel_dir].append(file_id)

        # build dir entries
        dir_entries: List[DirEntry] = []

        for d in sorted(dirs.keys()):
            child_files = tuple(sorted(dirs[d]))

            # compute subdirs
            subdirs = tuple(
                sorted(
                    k for k in dirs.keys()
                    if k != d and os.path.dirname(k) == d
                )
            )

            dir_id = _hash({"path": d, "files": child_files, "dirs": subdirs})

            dir_entries.append(
                DirEntry(
                    dir_id=dir_id,
                    rel_path=d,
                    children_files=child_files,
                    children_dirs=tuple(_hash(sd) for sd in subdirs),
                )
            )

        files_sorted = tuple(sorted(files, key=lambda f: f.rel_path))
        dirs_sorted = tuple(sorted(dir_entries, key=lambda d: d.rel_path))

        index_hash = _hash({
            "files": [f.file_id for f in files_sorted],
            "dirs": [d.dir_id for d in dirs_sorted],
        })

        return RepoIndex(
            root=self._root,
            files=files_sorted,
            dirs=dirs_sorted,
            index_hash=index_hash,
        )


# ---------------------------------------------------------------------------
# INCREMENTAL (DIFF)
# ---------------------------------------------------------------------------


class RepoIndexDiffer:
    """
    Computes differences between two RepoIndex instances.
    """

    def diff(self, old: RepoIndex, new: RepoIndex) -> Dict[str, Tuple[str, ...]]:
        old_files = {f.rel_path: f for f in old.files}
        new_files = {f.rel_path: f for f in new.files}

        added = tuple(sorted(p for p in new_files if p not in old_files))
        removed = tuple(sorted(p for p in old_files if p not in new_files))
        modified = tuple(
            sorted(
                p for p in new_files
                if p in old_files and new_files[p].content_hash != old_files[p].content_hash
            )
        )

        return {
            "added": added,
            "removed": removed,
            "modified": modified,
        }


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_repo_index(root: str) -> RepoIndex:
    return RepoIndexBuilder(root).build()


def diff_repo_index(old: RepoIndex, new: RepoIndex) -> Dict[str, Tuple[str, ...]]:
    return RepoIndexDiffer().diff(old, new)
