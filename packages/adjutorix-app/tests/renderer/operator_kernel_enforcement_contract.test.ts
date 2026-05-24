import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

describe("operator kernel enforcement contract", () => {
  it("blocks patch apply authority behind the mandatory operator kernel gate", () => {
    const patchIpc = read("src/main/ipc/patch_ipc.ts");
    const enforcement = read("src/main/operator/operator_kernel_enforcement.ts");

    expect(patchIpc).toContain("assertMandatoryOperatorKernelGate");
    expect(patchIpc).toContain("channels.apply");
    expect(patchIpc).toContain("operatorKernelReceiptId");
    expect(patchIpc).toContain("operatorKernelHash");

    expect(enforcement).toContain("ADJUTORIX_OPERATOR_KERNEL_GATE_REQUIRED");
    expect(enforcement).toContain("operatorKernelReceiptId");
    expect(enforcement).toContain("operatorKernelHash");
  });

  it("keeps the mandatory gate policy and IPC contract tests in the implemented suite", () => {
    const config = read("vitest.config.mjs");

    expect(config).toContain("operator_kernel_mandatory_gate_contract.test.ts");
    expect(config).toContain("operator_kernel_ipc_contract.test.ts");
    expect(config).toContain("operator_kernel_enforcement_contract.test.ts");
  });
});
