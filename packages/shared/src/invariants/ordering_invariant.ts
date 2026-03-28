export interface OrderingInvariantResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export interface SequencedValue {
  readonly sequence: number;
}

export function evaluateOrderingInvariant(
  values: readonly SequencedValue[]
): OrderingInvariantResult {
  const violations: string[] = [];
  const sequenced = values.map((value) => value.sequence);

  for (let index = 1; index < sequenced.length; index += 1) {
    const previous = sequenced[index - 1]!;
    const current = sequenced[index]!;
    if (current <= previous) {
      violations.push(
        `Sequence must be strictly increasing at index ${index}: ${previous} -> ${current}.`
      );
    }
  }

  if (sequenced.length > 0 && sequenced[0]! < 0) {
    violations.push("Sequence values must be >= 0.");
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
