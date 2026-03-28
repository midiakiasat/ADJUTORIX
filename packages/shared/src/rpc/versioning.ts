export const RPC_PROTOCOL_NAME = "adjutorix-rpc";
export const RPC_PROTOCOL_VERSION = "1.0.0";

export interface RpcVersionLock {
  readonly protocol: string;
  readonly version: string;
  readonly minimumCompatibleVersion: string;
}

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER_PATTERN = /^(\\d+)\\.(\\d+)\\.(\\d+)$/u;

export function parseSemver(value: string): ParsedSemver {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`invalid semantic version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);

  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

export function isVersionCompatible(
  expected: RpcVersionLock,
  actual: RpcVersionLock
): boolean {
  if (expected.protocol !== actual.protocol) {
    return false;
  }
  if (compareSemver(actual.version, expected.minimumCompatibleVersion) < 0) {
    return false;
  }
  return parseSemver(expected.version).major === parseSemver(actual.version).major;
}

export function assertVersionCompatible(
  expected: RpcVersionLock,
  actual: RpcVersionLock
): void {
  if (!isVersionCompatible(expected, actual)) {
    throw new Error(
      `incompatible protocol version: expected ${expected.protocol}@${expected.version} with minimum ${expected.minimumCompatibleVersion}, got ${actual.protocol}@${actual.version}`
    );
  }
}
