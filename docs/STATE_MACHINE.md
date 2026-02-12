# State Machine

## Canonical States

IDLE  
PLANNED  
PATCHED  
APPLIED  
RUNNING  
COMPLETED  
FAILED  

## Canonical Events

PLAN_CREATED  
PATCH_GENERATED  
PATCH_APPLIED  
RUN_STARTED  
RUN_COMPLETED  
RUN_FAILED  
RESET  

## Invariants

- Illegal transitions are rejected
- State changes must emit ledger event
- Replay must reproduce identical final state

## Ownership

Agent is the source of truth.
UI mirrors state via RPC.
