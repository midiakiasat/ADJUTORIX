import type { SequenceNumber } from "./sequence.js";

export type LedgerEdgeKind =
  | "supersedes"
  | "depends-on"
  | "produced"
  | "verified-by"
  | "derived-from"
  | "rolled-back-by"
  | "governed-by";

export interface LedgerEdge {
  readonly id: string;
  readonly sequence: SequenceNumber;
  readonly kind: LedgerEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly metadata: Readonly<Record<string, string>>;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

export function assertLedgerEdge(edge: LedgerEdge): void {
  assertNonEmpty(edge.id, "edge.id");
  assertNonEmpty(edge.from, "edge.from");
  assertNonEmpty(edge.to, "edge.to");
  if (edge.from === edge.to) {
    throw new Error("edge.from and edge.to must differ");
  }
  for (const [key, value] of Object.entries(edge.metadata)) {
    assertNonEmpty(key, "edge.metadata key");
    assertNonEmpty(value, `edge.metadata.${key}`);
  }
}

export function edgeKey(edge: Pick<LedgerEdge, "kind" | "from" | "to">): string {
  return `${edge.kind}:${edge.from}->${edge.to}`;
}
