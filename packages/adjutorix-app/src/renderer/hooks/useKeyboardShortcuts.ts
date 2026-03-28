import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * ADJUTORIX APP — SRC / HOOKS / useKeyboardShortcuts.ts
 *
 * Canonical governed keyboard-shortcut orchestration hook.
 *
 * Purpose:
 * - provide one renderer-side React hook that binds DOM keyboard events to the canonical
 *   keyboard policy layer
 * - unify event normalization, scope/context injection, chord-state progression,
 *   binding registration, dispatch planning, and callback execution
 * - prevent command palette, editor shell, chat, patch review, diagnostics, and settings
 *   from each attaching ad hoc listeners with conflicting precedence and cleanup behavior
 *
 * Architectural role:
 * - thin React integration layer over renderer/lib/keyboard.ts
 * - no hidden global singleton requirement, though callers may choose to mount one instance high
 * - supports local or document-level targets via caller-supplied event targets
 * - keeps chord state explicit, serializable, and locally scoped to the hook instance
 *
 * Hard invariants:
 * - identical bindings, context, and keyboard input produce identical dispatch decisions
 * - stale callback closures do not survive re-render due to ref-based indirection
 * - listener attachment and cleanup are deterministic
 * - no implicit mutation of caller bindings; runtime registration is explicit and reversible
 * - destructive shortcuts can be gated before callback execution
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// IMPORTS FROM CANONICAL KEYBOARD POLICY LAYER
// -----------------------------------------------------------------------------

import {
  buildDispatchPlan,
  clearChordState,
  filterBindingsForArea,
  matchKeyboardBinding,
  normalizeBinding,
  type KeyboardArea,
  type KeyboardBinding,
  type KeyboardChordState,
  type KeyboardContext,
  type KeyboardLikeEvent,
  type KeyboardMatchResult,
  type KeyboardRisk,
} from "../renderer/lib/keyboard";

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export interface KeyboardShortcutHandler {
  onInvoke?: (binding: KeyboardBinding) => void;
  onBlocked?: (result: KeyboardMatchResult) => void;
  onPartial?: (state: KeyboardChordState) => void;
  onMiss?: (event: KeyboardLikeEvent) => void;
  onRiskGate?: (binding: KeyboardBinding, risk: KeyboardRisk) => boolean;
}

export interface KeyboardShortcutTarget {
  addEventListener: (type: "keydown", listener: (event: KeyboardEvent) => void, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener: (type: "keydown", listener: (event: KeyboardEvent) => void, options?: boolean | EventListenerOptions) => void;
}

export interface UseKeyboardShortcutsOptions extends KeyboardShortcutHandler {
  bindings: KeyboardBinding[];
  context: KeyboardContext;
  enabled?: boolean;
  activeArea?: KeyboardArea;
  target?: KeyboardShortcutTarget | null;
  listenerOptions?: boolean | AddEventListenerOptions;
  resetChordOnBlur?: boolean;
}

export interface UseKeyboardShortcutsResult {
  activeBindings: KeyboardBinding[];
  chordState: KeyboardChordState;
  registerBinding: (binding: KeyboardBinding) => void;
  unregisterBinding: (bindingId: string) => void;
  resetChord: () => void;
  handleKeyboardEvent: (event: KeyboardLikeEvent, nativeEvent?: KeyboardEvent) => KeyboardMatchResult;
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function toKeyboardLikeEvent(event: KeyboardEvent): KeyboardLikeEvent {
  const target = event.target as HTMLElement | null;
  const tagName = target?.tagName?.toLowerCase() ?? null;
  const role = target?.getAttribute?.("role") ?? null;
  const input = target as HTMLInputElement | HTMLTextAreaElement | null;

  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    isComposing: event.isComposing,
    targetTagName: tagName,
    targetRole: role,
    targetIsContentEditable: Boolean(target?.isContentEditable),
    targetInputType: tagName === "input" ? (input as HTMLInputElement | null)?.type ?? null : null,
  };
}

function mergeBindings(staticBindings: KeyboardBinding[], dynamicBindings: Map<string, KeyboardBinding>): KeyboardBinding[] {
  const map = new Map<string, KeyboardBinding>();

  for (const binding of staticBindings) {
    const normalized = normalizeBinding(binding);
    map.set(normalized.id, normalized);
  }

  for (const binding of dynamicBindings.values()) {
    const normalized = normalizeBinding(binding);
    map.set(normalized.id, normalized);
  }

  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function shouldPreventForPlan(nativeEvent: KeyboardEvent | undefined, preventDefault: boolean, stopPropagation: boolean): void {
  if (!nativeEvent) return;
  if (preventDefault) nativeEvent.preventDefault();
  if (stopPropagation) nativeEvent.stopPropagation();
}

// -----------------------------------------------------------------------------
// HOOK
// -----------------------------------------------------------------------------

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): UseKeyboardShortcutsResult {
  const {
    bindings,
    context,
    enabled = true,
    activeArea,
    target,
    listenerOptions,
    resetChordOnBlur = true,
    onInvoke,
    onBlocked,
    onPartial,
    onMiss,
    onRiskGate,
  } = options;

  const dynamicBindingsRef = useRef<Map<string, KeyboardBinding>>(new Map());
  const chordStateRef = useRef<KeyboardChordState>(clearChordState());
  const invokeRef = useRef(onInvoke);
  const blockedRef = useRef(onBlocked);
  const partialRef = useRef(onPartial);
  const missRef = useRef(onMiss);
  const riskGateRef = useRef(onRiskGate);

  invokeRef.current = onInvoke;
  blockedRef.current = onBlocked;
  partialRef.current = onPartial;
  missRef.current = onMiss;
  riskGateRef.current = onRiskGate;

  const effectiveContext = useMemo<KeyboardContext>(() => {
    if (!activeArea) return context;
    return {
      ...context,
      activeArea,
    };
  }, [activeArea, context]);

  const activeBindings = useMemo(() => {
    const merged = mergeBindings(bindings, dynamicBindingsRef.current);
    return filterBindingsForArea(merged, effectiveContext.activeArea);
  }, [bindings, effectiveContext.activeArea]);

  const resetChord = useCallback(() => {
    chordStateRef.current = clearChordState();
  }, []);

  const registerBinding = useCallback((binding: KeyboardBinding) => {
    dynamicBindingsRef.current.set(binding.id, normalizeBinding(binding));
  }, []);

  const unregisterBinding = useCallback((bindingId: string) => {
    dynamicBindingsRef.current.delete(bindingId);
  }, []);

  const handleKeyboardEvent = useCallback(
    (event: KeyboardLikeEvent, nativeEvent?: KeyboardEvent): KeyboardMatchResult => {
      if (!enabled) {
        const miss: KeyboardMatchResult = { kind: "none" };
        missRef.current?.(event);
        return miss;
      }

      const mergedBindings = mergeBindings(bindings, dynamicBindingsRef.current);
      const result = matchKeyboardBinding(event, mergedBindings, effectiveContext, chordStateRef.current);

      if (result.kind === "partial" && result.partialState) {
        chordStateRef.current = result.partialState;
        partialRef.current?.(result.partialState);
        if (nativeEvent) {
          nativeEvent.preventDefault();
        }
        return result;
      }

      if (result.kind === "matched" && result.binding) {
        const plan = buildDispatchPlan(result.binding);
        const riskApproved = riskGateRef.current ? riskGateRef.current(result.binding, plan.risk) : true;

        if (!riskApproved) {
          const blocked: KeyboardMatchResult = {
            kind: "blocked",
            binding: result.binding,
            reason: `Risk gate denied ${plan.risk} shortcut execution.`,
          };
          blockedRef.current?.(blocked);
          chordStateRef.current = clearChordState();
          return blocked;
        }

        shouldPreventForPlan(nativeEvent, plan.preventDefault, plan.stopPropagation);
        chordStateRef.current = clearChordState();
        invokeRef.current?.(result.binding);
        return result;
      }

      if (result.kind === "blocked") {
        blockedRef.current?.(result);
        chordStateRef.current = clearChordState();
        return result;
      }

      chordStateRef.current = clearChordState();
      missRef.current?.(event);
      return result;
    },
    [bindings, effectiveContext, enabled],
  );

  useEffect(() => {
    const resolvedTarget = target ?? (typeof document !== "undefined" ? document : null);
    if (!resolvedTarget || !enabled) return;

    const listener = (nativeEvent: KeyboardEvent): void => {
      void handleKeyboardEvent(toKeyboardLikeEvent(nativeEvent), nativeEvent);
    };

    resolvedTarget.addEventListener("keydown", listener, listenerOptions);

    return () => {
      resolvedTarget.removeEventListener("keydown", listener, listenerOptions);
    };
  }, [enabled, handleKeyboardEvent, listenerOptions, target]);

  useEffect(() => {
    if (!resetChordOnBlur || typeof window === "undefined") return;

    const listener = (): void => {
      resetChord();
    };

    window.addEventListener("blur", listener);
    return () => {
      window.removeEventListener("blur", listener);
    };
  }, [resetChord, resetChordOnBlur]);

  return {
    activeBindings,
    chordState: chordStateRef.current,
    registerBinding,
    unregisterBinding,
    resetChord,
    handleKeyboardEvent,
  };
}

export default useKeyboardShortcuts;
