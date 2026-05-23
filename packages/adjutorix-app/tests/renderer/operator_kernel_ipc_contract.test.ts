import { describe, expect, it } from "vitest";
import fs from "node:fs";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

describe("operator kernel IPC contract", () => {
  it("binds real operator kernel to main IPC and preload", () => {
    const mainIpc = read("src/main/ipc/operator_kernel_ipc.ts");
    const preload = read("src/preload/preload.ts");
    const kernel = read("src/main/operator/real_operator_kernel.ts");

    expect(mainIpc).toContain("createOperatorKernelReceipt");
    expect(mainIpc).toContain("readLastOperatorKernelHash");
    expect(mainIpc).toContain("adjutorix:operatorKernel:createReceipt");
    expect(mainIpc).toContain("adjutorix:operatorKernel:lastHash");

    expect(preload).toContain("adjutorix:operatorKernel:createReceipt");
    expect(preload).toContain("adjutorix:operatorKernel:lastHash");

    expect(kernel).toContain("OPERATOR_KERNEL_RECEIPT");
    expect(kernel).toContain("apply_requires_verify_pass");
    expect(kernel).toContain("rollback_requires_apply_receipt");
  });

  it("registers operator kernel IPC from main process entry", () => {
    const main = read("src/main/index.ts");

    expect(main).toContain("registerOperatorKernelIpc");
    expect(main).toContain("./ipc/operator_kernel_ipc");
  });
});
