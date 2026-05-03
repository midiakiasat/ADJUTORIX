export type InteractionContractState = {
  selectedView: string;
  lastInteraction: null | {
    id: string;
    atMs: number;
    detail: string;
  };
};

export function createInitialInteractionContractState(): InteractionContractState {
  return {
    selectedView: "overview",
    lastInteraction: null,
  };
}

export function recordInteraction(
  state: InteractionContractState,
  id: string,
  detail: string,
): InteractionContractState {
  return {
    ...state,
    selectedView: id,
    lastInteraction: {
      id,
      atMs: Date.now(),
      detail,
    },
  };
}

export function assertEnabledControlHasVisibleContract(input: {
  label: string;
  disabled?: boolean;
  hasAction?: boolean;
  disabledReason?: string | null;
}): boolean {
  if (input.disabled) return Boolean(input.disabledReason);
  return Boolean(input.hasAction);
}
