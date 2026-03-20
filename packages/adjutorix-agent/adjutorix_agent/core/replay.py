from __future__ import annotations
from pathlib import Path
from typing import List

from .ledger import LedgerEvent
from .hashchain import compute_event_hash

import json

def replay(path: Path) -> List[LedgerEvent]:
    events: List[LedgerEvent] = []
    prev_hash = "0" * 64

    for line in path.read_text().splitlines():
        raw = json.loads(line)
        expected = raw["hash"]
        base = {k: raw[k] for k in raw if k != "hash"}
        if base["prev_hash"] != prev_hash:
            raise RuntimeError("Hash chain broken (prev_hash mismatch)")
        actual = compute_event_hash(base)
        if actual != expected:
            raise RuntimeError("Hash mismatch during replay")
        evt = LedgerEvent(**raw)
        events.append(evt)
        prev_hash = expected

    return events
