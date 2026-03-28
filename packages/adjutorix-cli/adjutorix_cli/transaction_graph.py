from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Iterator, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class GraphError(Exception):
    """Base error for transaction graph construction and analysis."""


class GraphValidationError(GraphError):
    """Raised when graph input violates structural invariants."""


class GraphQueryError(GraphError):
    """Raised when a graph query cannot be satisfied."""


class TransactionKind(str, Enum):
    patch = "patch"
    verify = "verify"
    apply_gate = "apply-gate"
    apply = "apply"
    rollback = "rollback"
    replay = "replay"
    workspace = "workspace"
    diagnostics = "diagnostics"
    shell = "shell"
    system = "system"
    unknown = "unknown"


class EdgeKind(str, Enum):
    replay = "replay"
    rollback = "rollback"
    causal = "causal"
    selection = "selection"
    dependency = "dependency"
    supersedes = "supersedes"
    unknown = "unknown"


class TransactionNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(ge=0)
    node_id: str = Field(min_length=1, alias="id")
    title: str = Field(min_length=1)
    kind: TransactionKind = TransactionKind.unknown
    phase: str | None = None
    replayable: bool | None = None
    verify_impact: str | None = None
    apply_impact: str | None = None
    status: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.node_id


class TransactionEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edge_id: str = Field(min_length=1, alias="id")
    from_seq: int = Field(alias="fromSeq", ge=0)
    to_seq: int = Field(alias="toSeq", ge=0)
    kind: EdgeKind = EdgeKind.unknown
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.edge_id


class TransactionGraphInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ledger_id: str = Field(min_length=1)
    entries: list[TransactionNode]
    edges: list[TransactionEdge]
    head_seq: int | None = Field(default=None, alias="headSeq")
    selected_seq: int | None = Field(default=None, alias="selectedSeq")
    replayable: bool | None = None
    continuity: str | None = None

    @model_validator(mode="after")
    def validate_selected_and_head_refs(self) -> "TransactionGraphInput":
        seqs = {entry.seq for entry in self.entries}
        if self.head_seq is not None and self.head_seq not in seqs:
            raise ValueError(f"headSeq={self.head_seq} does not refer to any node sequence")
        if self.selected_seq is not None and self.selected_seq not in seqs:
            raise ValueError(f"selectedSeq={self.selected_seq} does not refer to any node sequence")
        return self


@dataclass(slots=True)
class GraphSummary:
    ledger_id: str
    node_count: int
    edge_count: int
    root_count: int
    leaf_count: int
    replay_edge_count: int
    rollback_edge_count: int
    cycle_count: int
    max_depth: int
    head_seq: int | None
    selected_seq: int | None
    replayable: bool | None
    continuity: str | None


@dataclass(slots=True)
class Reachability:
    from_seq: int
    reachable_seqs: list[int]
    depth_by_seq: dict[int, int]


@dataclass(slots=True)
class PathResult:
    from_seq: int
    to_seq: int
    seq_path: list[int]
    edge_path: list[str]


@dataclass(slots=True)
class TransactionGraph:
    ledger_id: str
    nodes_by_seq: dict[int, TransactionNode]
    edges_by_id: dict[str, TransactionEdge]
    outgoing_by_seq: dict[int, list[TransactionEdge]]
    incoming_by_seq: dict[int, list[TransactionEdge]]
    head_seq: int | None = None
    selected_seq: int | None = None
    replayable: bool | None = None
    continuity: str | None = None
    _topological_cache: list[int] | None = field(default=None, init=False, repr=False)
    _cycles_cache: list[list[int]] | None = field(default=None, init=False, repr=False)

    def node(self, seq: int) -> TransactionNode:
        try:
            return self.nodes_by_seq[seq]
        except KeyError as exc:
            raise GraphQueryError(f"Unknown transaction sequence: {seq}") from exc

    def edge(self, edge_id: str) -> TransactionEdge:
        try:
            return self.edges_by_id[edge_id]
        except KeyError as exc:
            raise GraphQueryError(f"Unknown transaction edge: {edge_id}") from exc

    def nodes(self) -> list[TransactionNode]:
        return [self.nodes_by_seq[seq] for seq in sorted(self.nodes_by_seq)]

    def edges(self) -> list[TransactionEdge]:
        return [self.edges_by_id[edge_id] for edge_id in sorted(self.edges_by_id)]

    def root_seqs(self) -> list[int]:
        return sorted(seq for seq in self.nodes_by_seq if not self.incoming_by_seq.get(seq))

    def leaf_seqs(self) -> list[int]:
        return sorted(seq for seq in self.nodes_by_seq if not self.outgoing_by_seq.get(seq))

    def replay_edges(self) -> list[TransactionEdge]:
        return [edge for edge in self.edges() if edge.kind is EdgeKind.replay]

    def rollback_edges(self) -> list[TransactionEdge]:
        return [edge for edge in self.edges() if edge.kind is EdgeKind.rollback]

    def selected_node(self) -> TransactionNode | None:
        if self.selected_seq is None:
            return None
        return self.nodes_by_seq[self.selected_seq]

    def head_node(self) -> TransactionNode | None:
        if self.head_seq is None:
            return None
        return self.nodes_by_seq[self.head_seq]

    def out_neighbors(self, seq: int) -> list[int]:
        self.node(seq)
        return [edge.to_seq for edge in self.outgoing_by_seq.get(seq, [])]

    def in_neighbors(self, seq: int) -> list[int]:
        self.node(seq)
        return [edge.from_seq for edge in self.incoming_by_seq.get(seq, [])]

    def descendants(self, seq: int) -> Reachability:
        self.node(seq)
        visited: set[int] = {seq}
        queue: deque[tuple[int, int]] = deque([(seq, 0)])
        depth_by_seq: dict[int, int] = {seq: 0}
        while queue:
            current, depth = queue.popleft()
            for nxt in self.out_neighbors(current):
                if nxt in visited:
                    continue
                visited.add(nxt)
                depth_by_seq[nxt] = depth + 1
                queue.append((nxt, depth + 1))
        return Reachability(from_seq=seq, reachable_seqs=sorted(visited), depth_by_seq=depth_by_seq)

    def ancestors(self, seq: int) -> Reachability:
        self.node(seq)
        visited: set[int] = {seq}
        queue: deque[tuple[int, int]] = deque([(seq, 0)])
        depth_by_seq: dict[int, int] = {seq: 0}
        while queue:
            current, depth = queue.popleft()
            for prev in self.in_neighbors(current):
                if prev in visited:
                    continue
                visited.add(prev)
                depth_by_seq[prev] = depth + 1
                queue.append((prev, depth + 1))
        return Reachability(from_seq=seq, reachable_seqs=sorted(visited), depth_by_seq=depth_by_seq)

    def path_between(self, from_seq: int, to_seq: int) -> PathResult:
        self.node(from_seq)
        self.node(to_seq)
        if from_seq == to_seq:
            return PathResult(from_seq=from_seq, to_seq=to_seq, seq_path=[from_seq], edge_path=[])

        queue: deque[int] = deque([from_seq])
        prev_seq: dict[int, int | None] = {from_seq: None}
        prev_edge_id: dict[int, str | None] = {from_seq: None}

        while queue:
            current = queue.popleft()
            for edge in self.outgoing_by_seq.get(current, []):
                nxt = edge.to_seq
                if nxt in prev_seq:
                    continue
                prev_seq[nxt] = current
                prev_edge_id[nxt] = edge.id
                if nxt == to_seq:
                    seq_path: list[int] = []
                    edge_path: list[str] = []
                    cursor: int | None = to_seq
                    while cursor is not None:
                        seq_path.append(cursor)
                        edge_id = prev_edge_id[cursor]
                        if edge_id is not None:
                            edge_path.append(edge_id)
                        cursor = prev_seq[cursor]
                    seq_path.reverse()
                    edge_path.reverse()
                    return PathResult(from_seq=from_seq, to_seq=to_seq, seq_path=seq_path, edge_path=edge_path)
                queue.append(nxt)

        raise GraphQueryError(f"No directed path exists from seq {from_seq} to seq {to_seq}")

    def topological_order(self) -> list[int]:
        if self._topological_cache is not None:
            return list(self._topological_cache)

        indegree: dict[int, int] = {seq: 0 for seq in self.nodes_by_seq}
        for edge in self.edges():
            indegree[edge.to_seq] += 1

        queue: deque[int] = deque(sorted(seq for seq, degree in indegree.items() if degree == 0))
        order: list[int] = []
        local_out = {seq: list(edges) for seq, edges in self.outgoing_by_seq.items()}

        while queue:
            seq = queue.popleft()
            order.append(seq)
            for edge in local_out.get(seq, []):
                indegree[edge.to_seq] -= 1
                if indegree[edge.to_seq] == 0:
                    queue.append(edge.to_seq)

        if len(order) != len(self.nodes_by_seq):
            raise GraphQueryError("Graph is cyclic; no topological ordering exists")

        self._topological_cache = list(order)
        return order

    def cycles(self) -> list[list[int]]:
        if self._cycles_cache is not None:
            return [list(cycle) for cycle in self._cycles_cache]

        visited: set[int] = set()
        stack: set[int] = set()
        path: list[int] = []
        found: list[list[int]] = []

        def dfs(seq: int) -> None:
            visited.add(seq)
            stack.add(seq)
            path.append(seq)
            for nxt in self.out_neighbors(seq):
                if nxt not in visited:
                    dfs(nxt)
                elif nxt in stack:
                    try:
                        idx = path.index(nxt)
                    except ValueError:
                        idx = 0
                    cycle = path[idx:] + [nxt]
                    if cycle not in found:
                        found.append(cycle)
            stack.remove(seq)
            path.pop()

        for seq in sorted(self.nodes_by_seq):
            if seq not in visited:
                dfs(seq)

        self._cycles_cache = [list(cycle) for cycle in found]
        return found

    def is_acyclic(self) -> bool:
        return len(self.cycles()) == 0

    def max_depth(self) -> int:
        if not self.nodes_by_seq:
            return 0
        if not self.is_acyclic():
            raise GraphQueryError("Cannot compute max depth on cyclic graph")

        depth: dict[int, int] = {seq: 0 for seq in self.nodes_by_seq}
        for seq in self.topological_order():
            for edge in self.outgoing_by_seq.get(seq, []):
                depth[edge.to_seq] = max(depth[edge.to_seq], depth[seq] + 1)
        return max(depth.values(), default=0)

    def replay_lineage_for(self, seq: int) -> list[int]:
        self.node(seq)
        lineage: set[int] = {seq}
        queue: deque[int] = deque([seq])
        while queue:
            current = queue.popleft()
            for edge in self.incoming_by_seq.get(current, []):
                if edge.kind is not EdgeKind.replay:
                    continue
                if edge.from_seq in lineage:
                    continue
                lineage.add(edge.from_seq)
                queue.append(edge.from_seq)
        return sorted(lineage)

    def rollback_targets_for(self, seq: int) -> list[int]:
        self.node(seq)
        targets = [edge.to_seq for edge in self.outgoing_by_seq.get(seq, []) if edge.kind is EdgeKind.rollback]
        return sorted(targets)

    def selected_subgraph(self) -> "TransactionGraph":
        if self.selected_seq is None:
            raise GraphQueryError("No selected sequence is set on the graph")

        forward = set(self.descendants(self.selected_seq).reachable_seqs)
        backward = set(self.ancestors(self.selected_seq).reachable_seqs)
        included = sorted(forward | backward)
        edges = [
            edge
            for edge in self.edges()
            if edge.from_seq in included and edge.to_seq in included
        ]
        nodes = [self.nodes_by_seq[seq] for seq in included]
        return build_transaction_graph(
            {
                "ledger_id": self.ledger_id,
                "entries": [node.model_dump(by_alias=True) for node in nodes],
                "edges": [edge.model_dump(by_alias=True) for edge in edges],
                "headSeq": self.head_seq if self.head_seq in included else None,
                "selectedSeq": self.selected_seq,
                "replayable": self.replayable,
                "continuity": self.continuity,
            }
        )

    def summary(self) -> GraphSummary:
        return GraphSummary(
            ledger_id=self.ledger_id,
            node_count=len(self.nodes_by_seq),
            edge_count=len(self.edges_by_id),
            root_count=len(self.root_seqs()),
            leaf_count=len(self.leaf_seqs()),
            replay_edge_count=len(self.replay_edges()),
            rollback_edge_count=len(self.rollback_edges()),
            cycle_count=len(self.cycles()),
            max_depth=0 if not self.nodes_by_seq else (self.max_depth() if self.is_acyclic() else -1),
            head_seq=self.head_seq,
            selected_seq=self.selected_seq,
            replayable=self.replayable,
            continuity=self.continuity,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "ledger_id": self.ledger_id,
            "entries": [node.model_dump(by_alias=True) for node in self.nodes()],
            "edges": [edge.model_dump(by_alias=True) for edge in self.edges()],
            "headSeq": self.head_seq,
            "selectedSeq": self.selected_seq,
            "replayable": self.replayable,
            "continuity": self.continuity,
        }


@dataclass(slots=True)
class AsciiGraphRender:
    title: str
    lines: list[str]

    def to_text(self) -> str:
        return "\n".join([self.title, *self.lines]) if self.lines else self.title


def build_transaction_graph(raw: Mapping[str, Any] | TransactionGraphInput) -> TransactionGraph:
    try:
        model = raw if isinstance(raw, TransactionGraphInput) else TransactionGraphInput.model_validate(raw)
    except ValidationError as exc:
        raise GraphValidationError(f"Invalid transaction graph input: {exc}") from exc

    nodes_by_seq: dict[int, TransactionNode] = {}
    nodes_by_id: dict[str, TransactionNode] = {}
    for node in model.entries:
        if node.seq in nodes_by_seq:
            raise GraphValidationError(f"Duplicate node sequence detected: {node.seq}")
        if node.id in nodes_by_id:
            raise GraphValidationError(f"Duplicate node id detected: {node.id}")
        nodes_by_seq[node.seq] = node
        nodes_by_id[node.id] = node

    edges_by_id: dict[str, TransactionEdge] = {}
    outgoing_by_seq: dict[int, list[TransactionEdge]] = defaultdict(list)
    incoming_by_seq: dict[int, list[TransactionEdge]] = defaultdict(list)

    for edge in model.edges:
        if edge.id in edges_by_id:
            raise GraphValidationError(f"Duplicate edge id detected: {edge.id}")
        if edge.from_seq not in nodes_by_seq:
            raise GraphValidationError(f"Edge {edge.id} references unknown fromSeq={edge.from_seq}")
        if edge.to_seq not in nodes_by_seq:
            raise GraphValidationError(f"Edge {edge.id} references unknown toSeq={edge.to_seq}")
        if edge.from_seq == edge.to_seq:
            raise GraphValidationError(f"Self-edge is not allowed for edge {edge.id} at seq={edge.from_seq}")
        edges_by_id[edge.id] = edge
        outgoing_by_seq[edge.from_seq].append(edge)
        incoming_by_seq[edge.to_seq].append(edge)

    graph = TransactionGraph(
        ledger_id=model.ledger_id,
        nodes_by_seq=nodes_by_seq,
        edges_by_id=edges_by_id,
        outgoing_by_seq={seq: sorted(edges, key=lambda e: (e.to_seq, e.id)) for seq, edges in outgoing_by_seq.items()},
        incoming_by_seq={seq: sorted(edges, key=lambda e: (e.from_seq, e.id)) for seq, edges in incoming_by_seq.items()},
        head_seq=model.head_seq,
        selected_seq=model.selected_seq,
        replayable=model.replayable,
        continuity=model.continuity,
    )
    return graph


def diff_transaction_graphs(left: TransactionGraph, right: TransactionGraph) -> dict[str, Any]:
    left_nodes = set(left.nodes_by_seq)
    right_nodes = set(right.nodes_by_seq)
    left_edges = set(left.edges_by_id)
    right_edges = set(right.edges_by_id)

    changed_nodes: list[int] = []
    for seq in sorted(left_nodes & right_nodes):
        if left.nodes_by_seq[seq].model_dump(by_alias=True) != right.nodes_by_seq[seq].model_dump(by_alias=True):
            changed_nodes.append(seq)

    changed_edges: list[str] = []
    for edge_id in sorted(left_edges & right_edges):
        if left.edges_by_id[edge_id].model_dump(by_alias=True) != right.edges_by_id[edge_id].model_dump(by_alias=True):
            changed_edges.append(edge_id)

    return {
        "changed": bool(
            changed_nodes
            or changed_edges
            or (left_nodes - right_nodes)
            or (right_nodes - left_nodes)
            or (left_edges - right_edges)
            or (right_edges - left_edges)
            or left.head_seq != right.head_seq
            or left.selected_seq != right.selected_seq
            or left.replayable != right.replayable
            or left.continuity != right.continuity
        ),
        "added_nodes": sorted(right_nodes - left_nodes),
        "removed_nodes": sorted(left_nodes - right_nodes),
        "changed_nodes": changed_nodes,
        "added_edges": sorted(right_edges - left_edges),
        "removed_edges": sorted(left_edges - right_edges),
        "changed_edges": changed_edges,
        "head_changed": left.head_seq != right.head_seq,
        "selected_changed": left.selected_seq != right.selected_seq,
        "replayable_changed": left.replayable != right.replayable,
        "continuity_changed": left.continuity != right.continuity,
    }


def render_ascii_transaction_graph(graph: TransactionGraph) -> AsciiGraphRender:
    lines: list[str] = []
    title = f"Transaction Graph: {graph.ledger_id}"

    def marker(seq: int) -> str:
        flags: list[str] = []
        if graph.head_seq == seq:
            flags.append("HEAD")
        if graph.selected_seq == seq:
            flags.append("SELECTED")
        return f" [{'|'.join(flags)}]" if flags else ""

    if not graph.nodes_by_seq:
        return AsciiGraphRender(title=title, lines=["<empty>"])

    roots = graph.root_seqs()
    rendered_edges: set[str] = set()
    visited: set[int] = set()

    def walk(seq: int, prefix: str, depth: int) -> None:
        node = graph.node(seq)
        visited.add(seq)
        lines.append(
            f"{prefix}{seq}: {node.title} <{node.kind.value}>"
            f" status={node.status or '-'} replayable={node.replayable if node.replayable is not None else '-'}"
            f"{marker(seq)}"
        )
        children = graph.outgoing_by_seq.get(seq, [])
        for index, edge in enumerate(children):
            rendered_edges.add(edge.id)
            branch = "└─" if index == len(children) - 1 else "├─"
            next_prefix = prefix + ("   " if index == len(children) - 1 else "│  ")
            lines.append(f"{prefix}{branch} edge:{edge.kind.value} ({edge.id}) -> {edge.to_seq}")
            if edge.to_seq in visited:
                lines.append(f"{next_prefix}↺ cycle to {edge.to_seq}")
                continue
            walk(edge.to_seq, next_prefix, depth + 1)

    for root in roots:
        walk(root, "", 0)

    for seq in sorted(graph.nodes_by_seq):
        if seq in visited:
            continue
        lines.append(f"… disconnected component from seq {seq}")
        walk(seq, "", 0)

    unrendered_edges = sorted(edge_id for edge_id in graph.edges_by_id if edge_id not in rendered_edges)
    for edge_id in unrendered_edges:
        edge = graph.edge(edge_id)
        lines.append(f"! unrendered edge {edge.id}: {edge.from_seq} -> {edge.to_seq} ({edge.kind.value})")

    return AsciiGraphRender(title=title, lines=lines)


def summarize_transaction_graph(graph: TransactionGraph) -> dict[str, Any]:
    summary = graph.summary()
    return {
        "ledger_id": summary.ledger_id,
        "node_count": summary.node_count,
        "edge_count": summary.edge_count,
        "root_count": summary.root_count,
        "leaf_count": summary.leaf_count,
        "replay_edge_count": summary.replay_edge_count,
        "rollback_edge_count": summary.rollback_edge_count,
        "cycle_count": summary.cycle_count,
        "max_depth": summary.max_depth,
        "head_seq": summary.head_seq,
        "selected_seq": summary.selected_seq,
        "replayable": summary.replayable,
        "continuity": summary.continuity,
        "is_acyclic": graph.is_acyclic(),
    }


def selected_transaction_context(graph: TransactionGraph) -> dict[str, Any]:
    node = graph.selected_node()
    if node is None:
        raise GraphQueryError("No selected node available")
    lineage = graph.replay_lineage_for(node.seq)
    rollback_targets = graph.rollback_targets_for(node.seq)
    descendants = graph.descendants(node.seq).reachable_seqs
    ancestors = graph.ancestors(node.seq).reachable_seqs
    return {
        "selected_seq": node.seq,
        "selected_id": node.id,
        "title": node.title,
        "kind": node.kind.value,
        "status": node.status,
        "replayable": node.replayable,
        "verify_impact": node.verify_impact,
        "apply_impact": node.apply_impact,
        "replay_lineage": lineage,
        "rollback_targets": rollback_targets,
        "ancestor_seqs": ancestors,
        "descendant_seqs": descendants,
    }
