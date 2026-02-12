# Wire Protocol

## Transport

JSON-RPC style messaging over stdio / local HTTP.

All messages must be:

{
  "method": string,
  "params": object,
  "id": string
}

## Guarantees

- Typed payloads validated by schema
- Versioned contracts
- No untyped tool invocation
- No implicit side effects

## Core Methods

plan.create  
patch.generate  
fs.applyPatch  
run.execute  
ledger.export  
session.restore  
