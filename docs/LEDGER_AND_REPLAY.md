# Ledger and Replay

## Ledger Model

Append-only.
Line-delimited JSON.
Hash-chained.

Each entry:

{
  seq,
  ts,
  state,
  event,
  payload,
  prev_hash,
  hash
}

## Guarantees

- Tamper-evident
- Deterministic replay
- State reconstructable from genesis

## Replay Rules

1. Start at IDLE
2. Apply events in order
3. Validate hashchain
4. Recompute final state
5. Must match recorded final state
