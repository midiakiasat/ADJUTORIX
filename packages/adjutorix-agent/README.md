# ADJUTORIX

ADJUTORIX is a governed mutation, ledger, replay, and verification workspace built as a multi-package monorepo.

## Repository Layout

- `packages/adjutorix-agent` — execution, governance, ledger, replay, storage, verification
- `packages/adjutorix-app` — desktop application surface
- `packages/adjutorix-cli` — command-line operator surface
- `packages/orchestrator` — startup, shutdown, capability, dependency, and runtime guard orchestration
- `packages/shared` — canonical cross-package contracts, invariants, runtime types, and protocol surface
- `scripts` — operator entrypoints
- `tests` — repository-level contract, invariant, replay, recovery, performance, and end-to-end coverage
- `configs` — policy, CI, contracts, runtime, and tooling configuration

## Core Operating Rules

- no invisible mutation
- no direct write bypass around governed flows
- no unverifiable claim of state
- no replay ambiguity
- no renderer authority over protected mutation paths

## Primary Operator Commands

```bash
bash ./scripts/check.sh
bash ./scripts/smoke.sh
bash ./scripts/verify.sh
bash ./scripts/build.sh
bash ./scripts/doctor.sh
````

## Workspace Commands

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run check
pnpm run verify
```

## Packaging

```bash
bash ./scripts/package-macos.sh
```

## License

Licensed under the Apache License, Version 2.0.
