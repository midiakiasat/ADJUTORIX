from __future__ import annotations
import sys
from pathlib import Path
from adjutorix_agent.core.replay import replay

def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: export_ledger.py <ledger_path>")
        sys.exit(1)

    path = Path(sys.argv[1])
    events = replay(path)
    for e in events:
        print(f"{e.seq} {e.ts} {e.state} --{e.event}--> {e.hash}")

if __name__ == "__main__":
    main()
