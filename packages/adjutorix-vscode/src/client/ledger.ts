export interface LedgerEvent {
  seq: number;
  ts: string;
  session_id: string;
  state: string;
  event: string;
  payload?: unknown;
  prev_hash: string;
  hash: string;
}

export function parseLedger(text: string): LedgerEvent[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEvent)
    .sort((a, b) => a.seq - b.seq);
}

export function verifyHashChain(events: LedgerEvent[]): boolean {
  let prev = "0".repeat(64);
  for (const e of events) {
    if (e.prev_hash !== prev) return false;
    prev = e.hash;
  }
  return true;
}
