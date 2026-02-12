# ADJUTORIX Architecture

## Core Principle

Deterministic, governed execution pipeline:

Prompt → Plan → Patch → Review → Apply → Run → Result

No direct mutation.
No hidden side effects.
All transitions explicit.
All effects replayable.

## Layers

### 1. UI (VS Code Extension)
- Displays state machine
- Sends typed RPC requests
- Never writes to disk directly
- Renders ledger timeline

### 2. Agent (Execution Core)
- Owns state machine
- Owns patch gate
- Owns ledger + hashchain
- Enforces tool permissions
- Applies filesystem ops

### 3. Shared Contracts
- JSON schemas (state, transitions, ledger, fs ops)
- RPC method contracts
- Type definitions shared across UI + Agent

## Hard Invariants

- No disk mutation outside patch gate
- All state transitions validated
- All effects recorded in ledger
- Ledger is hash-chained
- Replay must deterministically reconstruct state
