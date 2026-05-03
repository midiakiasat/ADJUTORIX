export const ADJUTORIX_RELEASE_SURFACE_INVARIANT = "compile-time-release-surface-only";

export function assertReleaseSurfaceInvariantText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").toLowerCase();
  const hasCaptureDebugLabel =
    compact.includes("click(capture)") ||
    compact.includes("pointerdown(capture)") ||
    compact.includes("pointerup(capture)") ||
    compact.includes("pointermove(capture)");
  const hasCoordinateLeak = compact.includes("target=") && compact.includes("xy=");
  return !hasCaptureDebugLabel && !hasCoordinateLeak;
}
