# Quarantined domain smoke specs

These specs were moved out of the active smoke glob because they assert route/domain panels that the current renderer does not expose yet.

Observed current renderer surface:
- `ADJUTORIX`
- `Workspace Command Surface`
- workspace attachment status
- diagnostics summary

The quarantined specs expect additional active UI domains:
- settings persistence panel
- agent subscription/reconnect panel
- verify flow panel
- ledger flow panel
- patch review panel
- terminal run panel
- file editor/diagnostics roundtrip panel

They should be restored only when those surfaces exist in the renderer and are reachable by the routes used in the specs.
