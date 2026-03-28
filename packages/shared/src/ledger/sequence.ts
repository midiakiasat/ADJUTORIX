export type SequenceNumber = number;

export function compareSequence(left: SequenceNumber, right: SequenceNumber): number {
  return left - right;
}

export function highestSequence(values: readonly SequenceNumber[]): SequenceNumber {
  if (values.length === 0) {
    return 0;
  }

  let highest = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index]!;
    if (current > highest) {
      highest = current;
    }
  }
  return highest;
}

export function assertStrictAscending(values: readonly SequenceNumber[]): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if (previous >= current) {
      throw new Error(
        `sequence must be strictly ascending at index ${index}: ${previous} -> ${current}`
      );
    }
  }
}
