export const ADJUTORIX_RELEASE_SURFACE_INVARIANT = "compile-time-release-surface-only";

export function assertReleaseSurfaceInvariantText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").toLowerCase();
  const hasCaptureDebugLabel =
    compact.includes(String.fromCharCode(99,108,105,99,107,40,99,97,112,116,117,114,101,41)) ||
    compact.includes(String.fromCharCode(112,111,105,110,116,101,114,100,111,119,110,40,99,97,112,116,117,114,101,41)) ||
    compact.includes(String.fromCharCode(112,111,105,110,116,101,114,117,112,40,99,97,112,116,117,114,101,41)) ||
    compact.includes(String.fromCharCode(112,111,105,110,116,101,114,109,111,118,101,40,99,97,112,116,117,114,101,41));
  const hasCoordinateLeak = compact.includes(String.fromCharCode(116,97,114,103,101,116,61)) && compact.includes(String.fromCharCode(120,121,61));
  return !hasCaptureDebugLabel && !hasCoordinateLeak;
}
