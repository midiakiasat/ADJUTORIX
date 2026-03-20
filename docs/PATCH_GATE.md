# Patch Gate

## Purpose

Single choke point for filesystem mutation.

## Rules

- UI never writes directly
- Agent only applies declared FsOp operations
- All ops validated
- All ops logged to ledger

## Allowed Operations

write  
delete  
mkdir  
chmod  
rename  

## Forbidden

- Arbitrary Python file writes
- Tool-driven raw disk mutation
- Side effects outside declared ops

## Invariant

If it is not in a patch,
it does not exist.
