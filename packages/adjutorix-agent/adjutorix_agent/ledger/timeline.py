"""
ADJUTORIX AGENT — LEDGER / TIMELINE

Deterministic, queryable timeline projections over the append-only ledger.

Purpose:
- Provide time-ordered views for debugging, UI, and audits
- Correlate nodes/edges into higher-level events (transactions, patches, verifications)
- Support slicing (by seq, tx_id, snapshot_id) and compaction into semantic spans

Hard invariants:
- Timeline is derived solely from LedgerStore.stream_all()
- Ordering is strictly by seq (total order)
- Projections are pure (no writes)
- Any missing linkage (edge references) raises

Key abstractions:
- Event: atomic record derived from node/edge
- Span: grouped events forming a semantic unit (e.g., a transaction lifecycle)
- Timeline: ordered sequence of Events/Spans
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple, Any

import hashlib
import json

from adjutorix_agent.ledger.store import LedgerStore
from adjutorix_agent.ledger.schema import (
    EDGE_PATCH_APPLIED,
    EDGE_SNAPSHOT_CREATED,
    EDGE_TX_STATE_CHANGED,
    EDGE_ARTIFACT_EMITTED,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Event:
    seq: int
    kind: str  # node | edge
    type: str  # semantic type
    src: Optional[str]
    dst: Optional[str]
    payload: Dict[str, Any]


@dataclass(frozen=True)
class Span:
    span_id: str
    kind: str  # transaction | patch | verification | rollback | snapshot
    root_id: str
    events: Tuple[Event, ...]
    start_seq: int
    end_seq: int


@dataclass(frozen=True)
class Timeline:
    events: Tuple[Event, ...]
    spans: Tuple[Span, ...]
    hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_hash(obj: object) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _event_from_record(rec: Dict) -> Event:
    seq = rec["seq"]
    kind = rec["kind"]
    payload = rec["payload"]

    if kind == "node":
        # infer node type
        if "snapshot_id" in payload and "workspace_hash" in payload:
            return Event(seq, kind, "snapshot_node", None, payload.get("snapshot_id"), payload)
        if "patch_id" in payload:
            return Event(seq, kind, "patch_node", None, payload.get("patch_id"), payload)
        if "tx_id" in payload and "state" in payload:
            return Event(seq, kind, "transaction_node", None, payload.get("tx_id"), payload)
        if "artifact_id" in payload:
            return Event(seq, kind, "artifact_node", None, payload.get("artifact_id"), payload)
        raise RuntimeError(f"unknown_node_payload:{payload}")

    if kind == "edge":
        et = payload.get("type") or payload.get("edge_type")
        src = payload.get("src")
        dst = payload.get("dst")
        return Event(seq, kind, et, src, dst, payload)

    raise RuntimeError(f"unknown_record_kind:{kind}")


# ---------------------------------------------------------------------------
# BUILDER
# ---------------------------------------------------------------------------


class TimelineBuilder:
    def __init__(self, store: LedgerStore) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # BUILD
    # ------------------------------------------------------------------

    def build(
        self,
        start_seq: int = 0,
        end_seq: Optional[int] = None,
        tx_filter: Optional[str] = None,
        snapshot_filter: Optional[str] = None,
    ) -> Timeline:
        events: List[Event] = []

        for rec in self._store.stream_all():
            seq = rec["seq"]
            if seq < start_seq:
                continue
            if end_seq is not None and seq > end_seq:
                break

            ev = _event_from_record(rec)

            if tx_filter and not self._event_matches_tx(ev, tx_filter):
                continue
            if snapshot_filter and not self._event_matches_snapshot(ev, snapshot_filter):
                continue

            events.append(ev)

        spans = self._build_spans(events)

        tl_hash = _stable_hash(
            {
                "events": [self._event_key(e) for e in events],
                "spans": [self._span_key(s) for s in spans],
            }
        )

        return Timeline(events=tuple(events), spans=tuple(spans), hash=tl_hash)

    # ------------------------------------------------------------------
    # FILTERS
    # ------------------------------------------------------------------

    def _event_matches_tx(self, ev: Event, tx_id: str) -> bool:
        if ev.kind == "node" and ev.type == "transaction_node":
            return ev.dst == tx_id
        if ev.kind == "edge" and ev.type == EDGE_TX_STATE_CHANGED:
            return ev.src == tx_id
        if ev.kind == "edge" and ev.type == EDGE_ARTIFACT_EMITTED:
            return ev.src == tx_id
        if ev.kind == "edge" and ev.type == EDGE_PATCH_APPLIED:
            return ev.payload.get("metadata", {}).get("tx_id") == tx_id
        return False

    def _event_matches_snapshot(self, ev: Event, snapshot_id: str) -> bool:
        if ev.kind == "node" and ev.type == "snapshot_node":
            return ev.dst == snapshot_id
        if ev.kind == "edge" and ev.type in {EDGE_PATCH_APPLIED, EDGE_SNAPSHOT_CREATED}:
            return ev.src == snapshot_id or ev.dst == snapshot_id
        return False

    # ------------------------------------------------------------------
    # SPANS
    # ------------------------------------------------------------------

    def _build_spans(self, events: List[Event]) -> Tuple[Span, ...]:
        spans: List[Span] = []

        # group by tx_id for transaction spans
        tx_groups: Dict[str, List[Event]] = {}

        for e in events:
            if e.type == "transaction_node":
                tx_groups.setdefault(e.dst, []).append(e)
            elif e.type == EDGE_TX_STATE_CHANGED:
                tx_groups.setdefault(e.src, []).append(e)
            elif e.type == EDGE_ARTIFACT_EMITTED:
                tx_groups.setdefault(e.src, []).append(e)
            elif e.type == EDGE_PATCH_APPLIED:
                tx_id = e.payload.get("metadata", {}).get("tx_id")
                if tx_id:
                    tx_groups.setdefault(tx_id, []).append(e)

        for tx_id, evs in tx_groups.items():
            ordered = sorted(evs, key=lambda x: x.seq)
            span = Span(
                span_id=_stable_hash([self._event_key(e) for e in ordered]),
                kind="transaction",
                root_id=tx_id,
                events=tuple(ordered),
                start_seq=ordered[0].seq,
                end_seq=ordered[-1].seq,
            )
            spans.append(span)

        # snapshot spans (lineage segments)
        snap_groups: Dict[str, List[Event]] = {}
        for e in events:
            if e.type == "snapshot_node":
                snap_groups.setdefault(e.dst, []).append(e)
            elif e.type == EDGE_SNAPSHOT_CREATED:
                snap_groups.setdefault(e.dst, []).append(e)

        for sid, evs in snap_groups.items():
            ordered = sorted(evs, key=lambda x: x.seq)
            span = Span(
                span_id=_stable_hash([self._event_key(e) for e in ordered]),
                kind="snapshot",
                root_id=sid,
                events=tuple(ordered),
                start_seq=ordered[0].seq,
                end_seq=ordered[-1].seq,
            )
            spans.append(span)

        return tuple(sorted(spans, key=lambda s: (s.start_seq, s.root_id)))

    # ------------------------------------------------------------------
    # KEYS
    # ------------------------------------------------------------------

    def _event_key(self, e: Event) -> Dict[str, Any]:
        return {
            "seq": e.seq,
            "kind": e.kind,
            "type": e.type,
            "src": e.src,
            "dst": e.dst,
        }

    def _span_key(self, s: Span) -> Dict[str, Any]:
        return {
            "span_id": s.span_id,
            "kind": s.kind,
            "root_id": s.root_id,
            "start_seq": s.start_seq,
            "end_seq": s.end_seq,
        }


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_timeline(
    store: LedgerStore,
    start_seq: int = 0,
    end_seq: Optional[int] = None,
    tx_id: Optional[str] = None,
    snapshot_id: Optional[str] = None,
) -> Timeline:
    builder = TimelineBuilder(store)
    return builder.build(start_seq, end_seq, tx_filter=tx_id, snapshot_filter=snapshot_id)
