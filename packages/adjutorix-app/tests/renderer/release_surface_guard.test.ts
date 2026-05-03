import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertReleaseSurfaceInvariantText } from "../../src/renderer/lib/release_surface_guard";

const rendererRoot = join(process.cwd(), "src", "renderer");

function walk(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (path.includes(`${join("src", "renderer", "lib")}`)) return [];
        if (path.includes("quarantine")) return [];
        return walk(path);
      }
      if (!/\.(ts|tsx)$/.test(path)) return [];
      return [path];
    });
}

describe("release surface invariant", () => {
  it("does not ship capture-debug overlay source", () => {
    const offenders = walk(rendererRoot).filter((path) => {
      const text = readFileSync(path, "utf8");
      return !assertReleaseSurfaceInvariantText(text);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the release-surface invariant out of runtime bootstrap", () => {
    const main = readFileSync(join(rendererRoot, "main.tsx"), "utf8");
    expect(main).not.toContain("release_surface_guard");
    expect(main).not.toContain("installReleaseSurfaceGuard");
  });
});
