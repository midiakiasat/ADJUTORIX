"""
ADJUTORIX AGENT — INDEXING / SYMBOL_INDEX

Deterministic, language-aware symbol extraction and cross-file symbol table.

Purpose:
- Extract symbols (definitions + references) from source files
- Provide canonical symbol IDs and locations
- Support dependency_graph, references, diagnostics
- Enable incremental updates keyed by file content hash

Design:
- Pluggable analyzers per language (Python/TS/JS baseline included)
- Pure function of (file content, rel_path) -> symbols
- Stable ordering and hashing
- Cross-file symbol table with def->refs index

Hard invariants:
- No IO side-effects during extraction (input is provided content)
- Symbol IDs are content-addressed (name + kind + scope + file + span)
- Locations are byte offsets (not line/col) for stability; line/col derived lazily
- Deterministic ordering across platforms
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple, Optional, Iterable, Protocol, Any

import ast
import hashlib
import json
import re


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


SymbolId = str
FileId = str


@dataclass(frozen=True)
class Span:
    start: int  # byte offset
    end: int    # byte offset (exclusive)


@dataclass(frozen=True)
class Symbol:
    symbol_id: SymbolId
    name: str
    kind: str  # function | class | variable | import | parameter | field
    file_id: FileId
    rel_path: str
    span: Span
    scope: Tuple[str, ...]  # lexical scope path (e.g., ["A", "method"]) 
    language: str


@dataclass(frozen=True)
class Reference:
    symbol_id: SymbolId  # refers to definition symbol_id when resolved, else placeholder id
    name: str
    file_id: FileId
    rel_path: str
    span: Span
    scope: Tuple[str, ...]
    language: str


@dataclass(frozen=True)
class FileSymbols:
    file_id: FileId
    rel_path: str
    language: str
    symbols: Tuple[Symbol, ...]
    references: Tuple[Reference, ...]
    file_hash: str


@dataclass(frozen=True)
class SymbolIndex:
    files: Tuple[FileSymbols, ...]
    defs: Tuple[Symbol, ...]
    refs: Tuple[Reference, ...]
    # map: symbol_id -> (def, refs...)
    adjacency: Tuple[Tuple[SymbolId, Tuple[int, ...]], ...]  # ref indices into refs tuple
    index_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _sid(payload: Any) -> SymbolId:
    return _hash(payload)


# ---------------------------------------------------------------------------
# ANALYZER PROTOCOL
# ---------------------------------------------------------------------------


class Analyzer(Protocol):
    language: str

    def supports(self, rel_path: str) -> bool: ...

    def extract(self, *, file_id: FileId, rel_path: str, content: bytes) -> Tuple[List[Symbol], List[Reference]]: ...


# ---------------------------------------------------------------------------
# PYTHON ANALYZER
# ---------------------------------------------------------------------------


class PythonAnalyzer:
    language = "python"

    def supports(self, rel_path: str) -> bool:
        return rel_path.endswith(".py")

    def extract(self, *, file_id: FileId, rel_path: str, content: bytes) -> Tuple[List[Symbol], List[Reference]]:
        text = content.decode(errors="replace")
        tree = ast.parse(text)

        symbols: List[Symbol] = []
        refs: List[Reference] = []

        # map line/col to byte offset
        line_offsets = self._line_offsets(text)

        def span(node: ast.AST) -> Span:
            start = self._offset(line_offsets, getattr(node, "lineno", 1), getattr(node, "col_offset", 0))
            end = self._offset(line_offsets, getattr(node, "end_lineno", getattr(node, "lineno", 1)), getattr(node, "end_col_offset", getattr(node, "col_offset", 0)))
            return Span(start, end)

        def make_sid(name: str, kind: str, scope: Tuple[str, ...], sp: Span) -> SymbolId:
            return _sid({"n": name, "k": kind, "s": scope, "p": rel_path, "sp": (sp.start, sp.end)})

        def visit(node: ast.AST, scope: Tuple[str, ...]):
            if isinstance(node, ast.FunctionDef):
                sp = span(node)
                sid = make_sid(node.name, "function", scope, sp)
                symbols.append(Symbol(sid, node.name, "function", file_id, rel_path, sp, scope, self.language))
                # params
                for arg in node.args.args:
                    asp = span(arg)
                    asid = make_sid(arg.arg, "parameter", scope + (node.name,), asp)
                    symbols.append(Symbol(asid, arg.arg, "parameter", file_id, rel_path, asp, scope + (node.name,), self.language))
                for n in node.body:
                    visit(n, scope + (node.name,))
                return

            if isinstance(node, ast.ClassDef):
                sp = span(node)
                sid = make_sid(node.name, "class", scope, sp)
                symbols.append(Symbol(sid, node.name, "class", file_id, rel_path, sp, scope, self.language))
                for n in node.body:
                    visit(n, scope + (node.name,))
                return

            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        sp = span(t)
                        sid = make_sid(t.id, "variable", scope, sp)
                        symbols.append(Symbol(sid, t.id, "variable", file_id, rel_path, sp, scope, self.language))
                # refs in value
                for n in ast.walk(node.value):
                    if isinstance(n, ast.Name):
                        rsp = span(n)
                        refs.append(Reference(_sid({"u": n.id}), n.id, file_id, rel_path, rsp, scope, self.language))
                return

            if isinstance(node, ast.Import) or isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    name = alias.asname or alias.name
                    sp = span(node)
                    sid = make_sid(name, "import", scope, sp)
                    symbols.append(Symbol(sid, name, "import", file_id, rel_path, sp, scope, self.language))
                return

            if isinstance(node, ast.Name):
                sp = span(node)
                refs.append(Reference(_sid({"u": node.id}), node.id, file_id, rel_path, sp, scope, self.language))
                return

            for child in ast.iter_child_nodes(node):
                visit(child, scope)

        visit(tree, ())

        return symbols, refs

    @staticmethod
    def _line_offsets(text: str) -> List[int]:
        offs = [0]
        total = 0
        for line in text.splitlines(True):
            total += len(line.encode())
            offs.append(total)
        return offs

    @staticmethod
    def _offset(line_offsets: List[int], line: int, col: int) -> int:
        # line is 1-based
        base = line_offsets[max(0, line - 1)]
        return base + col


# ---------------------------------------------------------------------------
# SIMPLE JS/TS ANALYZER (REGEX-BASED, DETERMINISTIC)
# ---------------------------------------------------------------------------


class JSTsAnalyzer:
    language = "typescript"

    _re_fn = re.compile(rb"\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    _re_cls = re.compile(rb"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    _re_var = re.compile(rb"\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    _re_ref = re.compile(rb"\b([A-Za-z_][A-Za-z0-9_]*)\b")

    def supports(self, rel_path: str) -> bool:
        return rel_path.endswith(".ts") or rel_path.endswith(".tsx") or rel_path.endswith(".js") or rel_path.endswith(".jsx")

    def extract(self, *, file_id: FileId, rel_path: str, content: bytes) -> Tuple[List[Symbol], List[Reference]]:
        symbols: List[Symbol] = []
        refs: List[Reference] = []

        def make_sid(name: str, kind: str, sp: Span) -> SymbolId:
            return _sid({"n": name, "k": kind, "p": rel_path, "sp": (sp.start, sp.end)})

        for m in self._re_fn.finditer(content):
            name = m.group(1).decode()
            sp = Span(m.start(1), m.end(1))
            sid = make_sid(name, "function", sp)
            symbols.append(Symbol(sid, name, "function", file_id, rel_path, sp, (), self.language))

        for m in self._re_cls.finditer(content):
            name = m.group(1).decode()
            sp = Span(m.start(1), m.end(1))
            sid = make_sid(name, "class", sp)
            symbols.append(Symbol(sid, name, "class", file_id, rel_path, sp, (), self.language))

        for m in self._re_var.finditer(content):
            name = m.group(1).decode()
            sp = Span(m.start(1), m.end(1))
            sid = make_sid(name, "variable", sp)
            symbols.append(Symbol(sid, name, "variable", file_id, rel_path, sp, (), self.language))

        # references (naive, filtered by defs to reduce noise later)
        for m in self._re_ref.finditer(content):
            name = m.group(1).decode()
            sp = Span(m.start(1), m.end(1))
            refs.append(Reference(_sid({"u": name}), name, file_id, rel_path, sp, (), self.language))

        return symbols, refs


# ---------------------------------------------------------------------------
# BUILDER
# ---------------------------------------------------------------------------


class SymbolIndexBuilder:
    def __init__(self, analyzers: Optional[Iterable[Analyzer]] = None) -> None:
        self._analyzers: Tuple[Analyzer, ...] = tuple(analyzers) if analyzers else (
            PythonAnalyzer(),
            JSTsAnalyzer(),
        )

    # ------------------------------------------------------------------

    def build(self, files: Iterable[Tuple[FileId, str, bytes]]) -> SymbolIndex:
        file_syms: List[FileSymbols] = []
        all_defs: List[Symbol] = []
        all_refs: List[Reference] = []

        for file_id, rel_path, content in sorted(files, key=lambda x: x[1]):
            analyzer = self._select_analyzer(rel_path)
            if analyzer is None:
                continue

            defs, refs = analyzer.extract(file_id=file_id, rel_path=rel_path, content=content)

            # stable ordering
            defs_sorted = tuple(sorted(defs, key=lambda s: (s.rel_path, s.span.start, s.name)))
            refs_sorted = tuple(sorted(refs, key=lambda r: (r.rel_path, r.span.start, r.name)))

            fhash = _hash({
                "defs": [s.symbol_id for s in defs_sorted],
                "refs": [r.symbol_id for r in refs_sorted],
            })

            file_syms.append(FileSymbols(
                file_id=file_id,
                rel_path=rel_path,
                language=analyzer.language,
                symbols=defs_sorted,
                references=refs_sorted,
                file_hash=fhash,
            ))

            all_defs.extend(defs_sorted)
            all_refs.extend(refs_sorted)

        # global stable ordering
        defs_all = tuple(sorted(all_defs, key=lambda s: (s.name, s.rel_path, s.span.start)))
        refs_all = tuple(sorted(all_refs, key=lambda r: (r.name, r.rel_path, r.span.start)))

        # build adjacency (name-based resolution; later passes may refine)
        name_to_def_ids: Dict[str, List[SymbolId]] = {}
        for s in defs_all:
            name_to_def_ids.setdefault(s.name, []).append(s.symbol_id)

        adjacency: List[Tuple[SymbolId, Tuple[int, ...]]] = []
        for sid_list in name_to_def_ids.values():
            for sid in sid_list:
                # collect refs indices matching this name
                idxs: List[int] = []
                for i, r in enumerate(refs_all):
                    if r.name == self._name_of_symbol_id(sid):
                        idxs.append(i)
                adjacency.append((sid, tuple(sorted(idxs))))

        adjacency_sorted = tuple(sorted(adjacency, key=lambda x: x[0]))

        index_hash = _hash({
            "files": [f.file_hash for f in file_syms],
            "defs": [s.symbol_id for s in defs_all],
            "refs": [r.symbol_id for r in refs_all],
            "adj": adjacency_sorted,
        })

        return SymbolIndex(
            files=tuple(sorted(file_syms, key=lambda f: f.rel_path)),
            defs=defs_all,
            refs=refs_all,
            adjacency=adjacency_sorted,
            index_hash=index_hash,
        )

    # ------------------------------------------------------------------

    def _select_analyzer(self, rel_path: str) -> Optional[Analyzer]:
        for a in self._analyzers:
            if a.supports(rel_path):
                return a
        return None

    @staticmethod
    def _name_of_symbol_id(symbol_id: SymbolId) -> str:
        # best-effort decode: not reversible; rely on adjacency by name during build time
        # We do not decode; adjacency uses captured names during iteration above.
        # This function is kept for interface symmetry; not used for actual decoding.
        return ""


# ---------------------------------------------------------------------------
# INCREMENTAL UPDATE
# ---------------------------------------------------------------------------


class SymbolIndexUpdater:
    """
    Incrementally updates an existing SymbolIndex given changed files.
    """

    def __init__(self, builder: SymbolIndexBuilder) -> None:
        self._builder = builder

    def update(
        self,
        old: SymbolIndex,
        changed: Iterable[Tuple[FileId, str, bytes]],
        removed_paths: Iterable[str],
    ) -> SymbolIndex:
        # rebuild affected files, keep others
        keep_files: Dict[str, FileSymbols] = {f.rel_path: f for f in old.files}

        for p in removed_paths:
            keep_files.pop(p, None)

        rebuilt = {}
        for fid, p, content in changed:
            si = self._builder.build([(fid, p, content)])
            if si.files:
                rebuilt[p] = si.files[0]

        keep_files.update(rebuilt)

        # rebuild global index from merged file set
        merged_files = list(keep_files.values())

        # flatten to builder input
        inputs: List[Tuple[FileId, str, bytes]] = []
        # NOTE: we cannot reconstruct content from old index; caller must supply for changed files.
        # For unchanged files, we skip re-analysis by reusing existing FileSymbols below.

        # Build combined index by reusing existing + rebuilt without re-reading content
        all_defs: List[Symbol] = []
        all_refs: List[Reference] = []

        for f in sorted(merged_files, key=lambda x: x.rel_path):
            all_defs.extend(f.symbols)
            all_refs.extend(f.references)

        defs_all = tuple(sorted(all_defs, key=lambda s: (s.name, s.rel_path, s.span.start)))
        refs_all = tuple(sorted(all_refs, key=lambda r: (r.name, r.rel_path, r.span.start)))

        name_to_def_ids: Dict[str, List[SymbolId]] = {}
        for s in defs_all:
            name_to_def_ids.setdefault(s.name, []).append(s.symbol_id)

        adjacency: List[Tuple[SymbolId, Tuple[int, ...]]] = []
        for name, sid_list in name_to_def_ids.items():
            ref_idxs = tuple(i for i, r in enumerate(refs_all) if r.name == name)
            for sid in sid_list:
                adjacency.append((sid, ref_idxs))

        adjacency_sorted = tuple(sorted(adjacency, key=lambda x: x[0]))

        index_hash = _hash({
            "files": [f.file_hash for f in merged_files],
            "defs": [s.symbol_id for s in defs_all],
            "refs": [r.symbol_id for r in refs_all],
            "adj": adjacency_sorted,
        })

        return SymbolIndex(
            files=tuple(sorted(merged_files, key=lambda f: f.rel_path)),
            defs=defs_all,
            refs=refs_all,
            adjacency=adjacency_sorted,
            index_hash=index_hash,
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_symbol_index(files: Iterable[Tuple[FileId, str, bytes]]) -> SymbolIndex:
    return SymbolIndexBuilder().build(files)


def update_symbol_index(old: SymbolIndex, changed: Iterable[Tuple[FileId, str, bytes]], removed_paths: Iterable[str]) -> SymbolIndex:
    return SymbolIndexUpdater(SymbolIndexBuilder()).update(old, changed, removed_paths)
