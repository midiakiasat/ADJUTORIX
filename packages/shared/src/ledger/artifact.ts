import type { SequenceNumber } from "./sequence.js";

export type ArtifactKind =
  | "patch"
  | "snapshot"
  | "verify-summary"
  | "verify-log"
  | "diagnostics"
  | "report"
  | "rollback"
  | "index"
  | "metadata";

export interface ArtifactDigest {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface LedgerArtifact {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly digest: ArtifactDigest;
  readonly producedAtSequence: SequenceNumber;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

export function assertArtifactDigest(digest: ArtifactDigest): void {
  if (digest.algorithm !== "sha256") {
    throw new Error(`unsupported digest algorithm: ${digest.algorithm}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(digest.value)) {
    throw new Error("digest.value must be a lowercase sha256 hex string");
  }
}

export function assertLedgerArtifact(artifact: LedgerArtifact): void {
  assertNonEmpty(artifact.id, "artifact.id");
  assertNonEmpty(artifact.path, "artifact.path");
  assertNonEmpty(artifact.mediaType, "artifact.mediaType");
  if (artifact.byteSize < 0) {
    throw new Error("artifact.byteSize must be >= 0");
  }
  assertArtifactDigest(artifact.digest);
  for (const tag of artifact.tags) {
    assertNonEmpty(tag, "artifact.tags[]");
  }
  for (const [key, value] of Object.entries(artifact.metadata)) {
    assertNonEmpty(key, "artifact.metadata key");
    assertNonEmpty(value, `artifact.metadata.${key}`);
  }
}

export function artifactKey(artifact: Pick<LedgerArtifact, "kind" | "id">): string {
  return `${artifact.kind}:${artifact.id}`;
}
