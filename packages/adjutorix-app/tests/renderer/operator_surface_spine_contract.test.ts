import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(appRoot, "../..");

function readApp(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

function readRepo(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("operator surface spine contract", () => {
  it("renders one governed operator surface spine inside the app surface", () => {
    const app = readApp("src/renderer/App.tsx");
    const component = readApp("src/renderer/components/OperatorSurfaceSpinePanel.tsx");

    expect(app).toContain("OperatorSurfaceSpinePanel");
    expect(app).toContain("<OperatorSurfaceSpinePanel");
    expect(component).toContain("ADJUTORIX_OPERATOR_SURFACE_SPINE");
    expect(component).toContain('data-testid="operator-surface-spine"');
    expect(component).toContain('data-testid="operator-surface-spine-path"');
  });

  it("makes mission control, live kernel, execution runway, and finality reachable from the spine", () => {
    const app = readApp("src/renderer/App.tsx");
    const component = readApp("src/renderer/components/OperatorSurfaceSpinePanel.tsx");

    const spineIndex = app.indexOf("<OperatorSurfaceSpinePanel");
    const missionIndex = app.indexOf("<OperatorMissionControlPanel />");
    const runwayIndex = app.indexOf("<OperatorExecutionRunwayPanel />");
    const liveKernelIndex = app.indexOf("liveKernelCockpit={");

    expect(spineIndex).toBeGreaterThanOrEqual(0);
    expect(missionIndex).toBeGreaterThan(spineIndex);
    expect(runwayIndex).toBeGreaterThan(spineIndex);
    expect(liveKernelIndex).toBeGreaterThan(spineIndex);

    expect(component).toContain("mission-control");
    expect(component).toContain("live-kernel");
    expect(component).toContain("execution-runway");
    expect(component).toContain("evidence-finality");
  });

  it("declares the spine as required runtime surface policy", () => {
    const policy = readRepo("configs/runtime/operator_surface_spine_policy.json");

    expect(policy).toContain("ADJUTORIX_OPERATOR_SURFACE_SPINE");
    expect(policy).toContain("orphan operator panel");
    expect(policy).toContain("hidden patch apply path");
    expect(policy).toContain("surface added without reachability contract");
  });

  it("keeps the spine contract in the implemented Vitest suite", () => {
    const config = readApp("vitest.config.mjs");

    expect(config).toContain("tests/renderer/operator_surface_spine_contract.test.ts");
  });
});
