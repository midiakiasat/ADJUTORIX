from **future** import annotations

import hashlib
import json
from typing import Iterable

def stable_hash(values: Iterable[str]) -> str:
payload = json.dumps(sorted(values), separators=(",", ":"), ensure_ascii=True)
return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def render_summary(values: Iterable[str]) -> dict[str, object]:
normalized = [value.strip() for value in values if value.strip()]
return {
"count": len(normalized),
"values": normalized,
"digest": stable_hash(normalized),
}

if **name** == "**main**":
print(json.dumps(render_summary(["alpha", "beta", "gamma"]), indent=2))
