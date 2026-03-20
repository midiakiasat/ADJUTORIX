from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Any


@dataclass(frozen=True)
class LockOwner:
    session_id: str
    owner: str
    job_id: str
    pid: int
    created_at: str  # ISO8601

    @staticmethod
    def now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @classmethod
    def create(cls, session_id: str, owner: str, job_id: str, pid: int) -> "LockOwner":
        return cls(
            session_id=session_id,
            owner=owner,
            job_id=job_id,
            pid=pid,
            created_at=cls.now_iso(),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "owner": self.owner,
            "job_id": self.job_id,
            "pid": self.pid,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LockOwner":
        return cls(
            session_id=str(data.get("session_id", "")),
            owner=str(data.get("owner", "")),
            job_id=str(data.get("job_id", "")),
            pid=int(data.get("pid", -1)),
            created_at=str(data.get("created_at", "")),
        )
