import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../../");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("operator unified control spine contract", () => {
  it("extends the spine to evidence ledger and diagnostics console", () => {
    const spine = read("packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx");

    expect(spine).toContain("ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE");
    expect(spine).toContain("evidence-ledger");
    expect(spine).toContain("diagnostics-console");
    expect(spine).toContain("evidenceLedger");
    expect(spine).toContain("diagnosticsConsole");
    expect(spine).toContain("operator-unified-control-spine-active-surface");
  });

  it("binds ledger and diagnostics into the app spine instead of rendering them as scattered siblings", () => {
    const app = read("packages/adjutorix-app/src/renderer/App.tsx");

    expect(app).toContain("<OperatorSurfaceSpinePanel");

    expect(app).toMatch(
      /missionControl\s*=\s*{\s*<OperatorMissionControlPanel\s*\/>\s*}/s,
    );
    expect(app).toMatch(
      /executionRunway\s*=\s*{\s*<OperatorExecutionRunwayPanel\s*\/>\s*}/s,
    );
    expect(app).toMatch(
      /evidenceLedger\s*=\s*{\s*<OperatorEvidenceLedgerPanel\s*\/>\s*}/s,
    );
    expect(app).toMatch(
      /diagnosticsConsole\s*=\s*{\s*<OperatorDiagnosticsConsolePanel\s*\/>\s*}/s,
    );

    const ledgerRenderCount = [...app.matchAll(/<OperatorEvidenceLedgerPanel\s*\/>/g)].length;
    const diagnosticsRenderCount = [...app.matchAll(/<OperatorDiagnosticsConsolePanel\s*\/>/g)].length;

    expect(ledgerRenderCount).toBe(1);
    expect(diagnosticsRenderCount).toBe(1);
  });

  it("declares unified control spine runtime policy", () => {
    const policy = JSON.parse(
      read("configs/runtime/operator_unified_control_spine_policy.json"),
    ) as {
      required: boolean;
      surface: string;
      governedPath: string[];
    };

    expect(policy.required).toBe(true);
    expect(policy.surface).toBe("ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE");
    expect(policy.governedPath).toEqual([
      "mission-control",
      "live-kernel",
      "execution-runway",
      "evidence-ledger",
      "diagnostics-console",
    ]);
  });

  it("keeps the unified control spine test in the implemented Vitest suite", () => {
    const vitestConfig = read("packages/adjutorix-app/vitest.config.mjs");

    expect(vitestConfig).toContain("operator_unified_control_spine_contract.test.ts");
  });
});
