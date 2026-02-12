from __future__ import annotations
import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .hashchain import compute_event_hash

@dataclass
class LedgerEvent:
    seq: int
    ts: str
    session_id: str
    state: str
    event: str
    payload: Optional[Dict[str, Any]]
    prev_hash: str
    hash: str

class Ledger:
    def __init__(self, path: Path, session_id: str) -> None:
        self.path = path
        self.session_id = session_id
        self._events: List[LedgerEvent] = []
        self._last_hash: str = "0" * 64
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            self._load()

    def _load(self) -> None:
        lines = self.path.read_text().splitlines()
        for line in lines:
            raw = json.loads(line)
            evt = LedgerEvent(**raw)
            self._events.append(evt)
            self._last_hash = evt.hash

    def append(self, state: str, event: str, payload: Optional[Dict[str, Any]] = None) -> LedgerEvent:
        seq = len(self._events)
        ts = datetime.now(timezone.utc).isoformat()
        base = {
            "seq": seq,
            "ts": ts,
            "session_id": self.session_id,
            "state": state,
            "event": event,
            "payload": payload,
            "prev_hash": self._last_hash
        }
        h = compute_event_hash(base)
        evt = LedgerEvent(**base, hash=h)
        self._events.append(evt)
        self._last_hash = h
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(evt), separators=(",", ":")) + "\n")
        return evt

    @property
    def events(self) -> List[LedgerEvent]:
        return list(self._events)
