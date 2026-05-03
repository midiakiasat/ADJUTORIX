# ADJUTORIX remote verification

`adjutorix-verify.yml` is the repository-level remote verification gate.

It installs from the frozen pnpm lockfile, runs `pnpm run verify`, and asserts the tracked tree remains clean after verification.
