/*
 * ADJUTORIX APP — RENDERER / LIB / keyboard.ts
 *
 * Canonical renderer-wide keyboard intent, chord parsing, routing, matching, focus gating,
 * and dispatch planning boundary.
 *
 * Purpose:
 * - provide one deterministic keyboard model for the entire renderer so command palette,
 *   editor, chat, terminal, patch review, diagnostics, and shell surfaces do not invent
 *   incompatible shortcut semantics
 * - normalize browser keyboard events into canonical intent objects
 * - model keybindings, scopes, precedence, enablement, safety posture, and focus eligibility
 * - support single-stroke shortcuts and bounded multi-stroke chords without hidden timing state
 * - produce explicit dispatch plans that higher layers can execute, reject, or surface
 *
 * Architectural role:
 * - pure keyboard policy / normalization / matching module
 * - no DOM mutation, no React state, no timers, no global singleton, no hidden listeners
 * - callers feed raw keyboard-like events and current context into this module
 * - callers own side effects such as preventDefault(), focusing, command execution, and UI updates
 *
 * Hard invariants:
 * - identical inputs produce identical outputs
 * - keybinding precedence is explicit and stable
 * - focus/target eligibility is evaluated before command selection
 * - unsafe/destructive bindings remain explicit and can be filtered or gated
 * - chord state is caller-owned and serializable
 * - matching never depends on locale-sensitive display strings alone
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type KeyboardModifier = "ctrl" | "meta" | "alt" | "shift";

export type KeyboardArea =
  | "global"
  | "workspace"
  | "editor"
  | "diff"
  | "patch-review"
  | "verify"
  | "ledger"
  | "diagnostics"
  | "chat"
  | "terminal"
  | "palette"
  | "settings"
  | "about"
  | "custom";

export type KeyboardRisk = "safe" | "guarded" | "destructive";

export type KeyboardEligibility =
  | "any"
  | "not-typing"
  | "typing-allowed"
  | "editor-only"
  | "terminal-only"
  | "palette-only"
  | "chat-only"
  | "custom";

export interface KeyboardStroke {
  key: string;
  code?: string | null;
  modifiers: KeyboardModifier[];
}

export interface KeyboardChord {
  strokes: KeyboardStroke[];
}

export interface KeyboardBinding {
  id: string;
  commandId: string;
  area: KeyboardArea;
  chord: KeyboardChord;
  priority: number;
  risk?: KeyboardRisk;
  eligibility?: KeyboardEligibility;
  when?: string | null;
  enabled?: boolean;
  enabledReason?: string | null;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  description?: string | null;
}

export interface KeyboardLikeEvent {
  key: string;
  code?: string | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  targetTagName?: string | null;
  targetRole?: string | null;
  targetIsContentEditable?: boolean;
  targetInputType?: string | null;
}

export interface KeyboardContext {
  activeArea: KeyboardArea;
  areaStack?: KeyboardArea[];
  isTypingContext?: boolean;
  editorFocused?: boolean;
  terminalFocused?: boolean;
  paletteOpen?: boolean;
  chatFocused?: boolean;
  settingsFocused?: boolean;
  customFlags?: Record<string, boolean>;
}

export interface KeyboardChordState {
  pendingBindingIds: string[];
  consumedStrokes: KeyboardStroke[];
}

export interface NormalizedKeyboardEvent {
  stroke: KeyboardStroke;
  repeated: boolean;
  composing: boolean;
  targetKind: "input" | "textarea" | "select" | "contenteditable" | "button" | "link" | "other";
  typingLikeTarget: boolean;
}

export interface KeyboardMatchResult {
  kind: "none" | "partial" | "matched" | "blocked";
  binding?: KeyboardBinding;
  partialState?: KeyboardChordState | null;
  reason?: string;
}

export interface KeyboardDispatchPlan {
  binding: KeyboardBinding;
  commandId: string;
  preventDefault: boolean;
  stopPropagation: boolean;
  risk: KeyboardRisk;
}

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

export const KEYBOARD_LIB_VERSION = "1.0.0";

const MODIFIER_ORDER: readonly KeyboardModifier[] = Object.freeze(["ctrl", "meta", "alt", "shift"]);

const SPECIAL_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  esc: "escape",
  return: "enter",
  del: "delete",
  cmd: "meta",
  command: "meta",
  option: "alt",
  control: "ctrl",
  spacebar: "space",
  " ": "space",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  plus: "+",
});

const DISPLAY_KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  meta: "Meta",
});

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function asSortedUniqueModifiers(modifiers: Iterable<KeyboardModifier>): KeyboardModifier[] {
  const set = new Set<KeyboardModifier>();
  for (const mod of modifiers) set.add(mod);
  return MODIFIER_ORDER.filter((mod) => set.has(mod));
}

function normalizeKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed) return "";

  const alias = SPECIAL_KEY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  if (trimmed.length === 1) {
    return trimmed.toLowerCase();
  }

  return trimmed.toLowerCase();
}

function normalizeCode(rawCode?: string | null): string | null {
  const value = rawCode?.trim();
  return value ? value : null;
}

function strokeIdentity(stroke: KeyboardStroke): string {
  const modifiers = asSortedUniqueModifiers(stroke.modifiers).join("+");
  const key = normalizeKey(stroke.key);
  return modifiers ? `${modifiers}+${key}` : key;
}

function chordIdentity(chord: KeyboardChord): string {
  return chord.strokes.map(strokeIdentity).join(" ");
}

function targetKind(event: KeyboardLikeEvent): NormalizedKeyboardEvent["targetKind"] {
  const tag = event.targetTagName?.trim().toLowerCase();
  if (event.targetIsContentEditable) return "contenteditable";
  if (tag === "input") return "input";
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  return "other";
}

function isTypingLikeTarget(event: KeyboardLikeEvent): boolean {
  const kind = targetKind(event);
  if (kind === "textarea" || kind === "contenteditable" || kind === "select") return true;
  if (kind === "input") {
    const inputType = event.targetInputType?.toLowerCase() ?? "text";
    return !["checkbox", "radio", "range", "button", "submit", "reset", "color"].includes(inputType);
  }
  return false;
}

function strokeEquals(a: KeyboardStroke, b: KeyboardStroke): boolean {
  return normalizeKey(a.key) === normalizeKey(b.key) &&
    asSortedUniqueModifiers(a.modifiers).join("|") === asSortedUniqueModifiers(b.modifiers).join("|");
}

function areaRank(area: KeyboardArea, context: KeyboardContext): number {
  const stack = [context.activeArea, ...(context.areaStack ?? [])];
  const idx = stack.indexOf(area);
  if (idx === -1) return area === "global" ? 1 : 0;
  return 100 - idx;
}

function evaluateEligibility(binding: KeyboardBinding, context: KeyboardContext, normalized: NormalizedKeyboardEvent): string | null {
  const eligibility = binding.eligibility ?? "any";
  switch (eligibility) {
    case "any":
      return null;
    case "not-typing":
      return context.isTypingContext || normalized.typingLikeTarget ? "Blocked in typing context." : null;
    case "typing-allowed":
      return null;
    case "editor-only":
      return context.editorFocused ? null : "Binding requires editor focus.";
    case "terminal-only":
      return context.terminalFocused ? null : "Binding requires terminal focus.";
    case "palette-only":
      return context.paletteOpen ? null : "Binding requires palette focus.";
    case "chat-only":
      return context.chatFocused ? null : "Binding requires chat focus.";
    case "custom":
      return null;
    default:
      return null;
  }
}

function compareBindings(a: KeyboardBinding, b: KeyboardBinding, context: KeyboardContext): number {
  const areaDelta = areaRank(b.area, context) - areaRank(a.area, context);
  if (areaDelta !== 0) return areaDelta;

  if (a.priority !== b.priority) return b.priority - a.priority;

  const riskRank: Record<KeyboardRisk, number> = { safe: 0, guarded: 1, destructive: 2 };
  const riskDelta = riskRank[a.risk ?? "safe"] - riskRank[b.risk ?? "safe"];
  if (riskDelta !== 0) return riskDelta;

  return a.id.localeCompare(b.id);
}

// -----------------------------------------------------------------------------
// NORMALIZATION
// -----------------------------------------------------------------------------

export function normalizeKeyboardEvent(event: KeyboardLikeEvent): NormalizedKeyboardEvent {
  const modifiers: KeyboardModifier[] = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.metaKey) modifiers.push("meta");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");

  return {
    stroke: {
      key: normalizeKey(event.key),
      code: normalizeCode(event.code),
      modifiers: asSortedUniqueModifiers(modifiers),
    },
    repeated: Boolean(event.repeat),
    composing: Boolean(event.isComposing),
    targetKind: targetKind(event),
    typingLikeTarget: isTypingLikeTarget(event),
  };
}

export function normalizeStroke(input: string | KeyboardStroke): KeyboardStroke {
  if (typeof input !== "string") {
    return {
      key: normalizeKey(input.key),
      code: normalizeCode(input.code),
      modifiers: asSortedUniqueModifiers(input.modifiers),
    };
  }

  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error(`Invalid keyboard stroke: ${input}`);
  }

  const modifiers: KeyboardModifier[] = [];
  let key = "";

  for (const part of parts) {
    const normalized = normalizeKey(part);
    if (normalized === "ctrl" || normalized === "meta" || normalized === "alt" || normalized === "shift") {
      modifiers.push(normalized);
    } else {
      if (key) {
        throw new Error(`Keyboard stroke has multiple non-modifier keys: ${input}`);
      }
      key = normalized;
    }
  }

  if (!key) {
    throw new Error(`Keyboard stroke is missing terminal key: ${input}`);
  }

  return {
    key,
    modifiers: asSortedUniqueModifiers(modifiers),
  };
}

export function normalizeChord(input: string | KeyboardChord): KeyboardChord {
  if (typeof input !== "string") {
    return {
      strokes: input.strokes.map(normalizeStroke),
    };
  }

  const strokes = input
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(normalizeStroke);

  if (strokes.length === 0) {
    throw new Error(`Invalid keyboard chord: ${input}`);
  }

  return { strokes };
}

export function normalizeBinding(binding: KeyboardBinding): KeyboardBinding {
  return {
    ...binding,
    enabled: binding.enabled ?? true,
    risk: binding.risk ?? "safe",
    eligibility: binding.eligibility ?? "any",
    preventDefault: binding.preventDefault ?? true,
    stopPropagation: binding.stopPropagation ?? false,
    chord: normalizeChord(binding.chord),
  };
}

// -----------------------------------------------------------------------------
// MATCHING / ROUTING
// -----------------------------------------------------------------------------

export function startChordState(bindingIds: string[], consumed: KeyboardStroke[]): KeyboardChordState {
  return {
    pendingBindingIds: [...bindingIds].sort(),
    consumedStrokes: consumed.map(normalizeStroke),
  };
}

export function clearChordState(): KeyboardChordState {
  return {
    pendingBindingIds: [],
    consumedStrokes: [],
  };
}

export function matchKeyboardBinding(
  rawEvent: KeyboardLikeEvent,
  bindings: KeyboardBinding[],
  context: KeyboardContext,
  chordState?: KeyboardChordState | null,
): KeyboardMatchResult {
  const normalized = normalizeKeyboardEvent(rawEvent);

  if (normalized.composing) {
    return { kind: "blocked", reason: "Input composition active." };
  }

  const canonicalBindings = bindings.map(normalizeBinding);
  const candidates = canonicalBindings
    .filter((binding) => binding.enabled !== false)
    .filter((binding) => areaRank(binding.area, context) > 0)
    .filter((binding) => {
      if (!chordState || chordState.pendingBindingIds.length === 0) return true;
      return chordState.pendingBindingIds.includes(binding.id);
    })
    .sort((a, b) => compareBindings(a, b, context));

  const partialMatches: KeyboardBinding[] = [];
  const fullMatches: KeyboardBinding[] = [];
  const blockedReasons: string[] = [];

  for (const binding of candidates) {
    const prior = chordState?.consumedStrokes ?? [];
    const expectedIndex = prior.length;
    const expectedStroke = binding.chord.strokes[expectedIndex];
    if (!expectedStroke) continue;

    const prefixValid = prior.every((stroke, index) => strokeEquals(stroke, binding.chord.strokes[index]));
    if (!prefixValid) continue;
    if (!strokeEquals(normalized.stroke, expectedStroke)) continue;

    const eligibilityBlock = evaluateEligibility(binding, context, normalized);
    if (eligibilityBlock) {
      blockedReasons.push(`${binding.id}: ${eligibilityBlock}`);
      continue;
    }

    if (binding.chord.strokes.length === expectedIndex + 1) {
      fullMatches.push(binding);
    } else {
      partialMatches.push(binding);
    }
  }

  if (fullMatches.length > 0) {
    const winner = [...fullMatches].sort((a, b) => compareBindings(a, b, context))[0];
    return { kind: "matched", binding: winner };
  }

  if (partialMatches.length > 0) {
    const nextState = startChordState(
      partialMatches.map((binding) => binding.id),
      [...(chordState?.consumedStrokes ?? []), normalized.stroke],
    );
    return { kind: "partial", partialState: nextState };
  }

  if (blockedReasons.length > 0) {
    return { kind: "blocked", reason: blockedReasons.sort().join(" | ") };
  }

  return { kind: "none" };
}

export function buildDispatchPlan(binding: KeyboardBinding): KeyboardDispatchPlan {
  const normalized = normalizeBinding(binding);
  return {
    binding: normalized,
    commandId: normalized.commandId,
    preventDefault: normalized.preventDefault ?? true,
    stopPropagation: normalized.stopPropagation ?? false,
    risk: normalized.risk ?? "safe",
  };
}

// -----------------------------------------------------------------------------
// FILTERING / QUERYING
// -----------------------------------------------------------------------------

export function filterBindingsForArea(
  bindings: KeyboardBinding[],
  area: KeyboardArea,
): KeyboardBinding[] {
  return bindings
    .map(normalizeBinding)
    .filter((binding) => binding.area === area || binding.area === "global")
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getBindingsForCommand(
  bindings: KeyboardBinding[],
  commandId: string,
): KeyboardBinding[] {
  return bindings
    .map(normalizeBinding)
    .filter((binding) => binding.commandId === commandId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function detectBindingConflicts(bindings: KeyboardBinding[]): Array<{
  identity: string;
  area: KeyboardArea;
  bindingIds: string[];
}> {
  const normalized = bindings.map(normalizeBinding);
  const groups = new Map<string, { area: KeyboardArea; bindingIds: string[] }>();

  for (const binding of normalized) {
    const key = `${binding.area}::${chordIdentity(binding.chord)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.bindingIds.push(binding.id);
    } else {
      groups.set(key, { area: binding.area, bindingIds: [binding.id] });
    }
  }

  return [...groups.entries()]
    .filter(([, value]) => value.bindingIds.length > 1)
    .map(([identity, value]) => ({
      identity,
      area: value.area,
      bindingIds: value.bindingIds.sort(),
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

// -----------------------------------------------------------------------------
// DISPLAY HELPERS
// -----------------------------------------------------------------------------

export function formatStrokeDisplay(stroke: KeyboardStroke): string {
  const parts: string[] = [];
  for (const mod of asSortedUniqueModifiers(stroke.modifiers)) {
    parts.push(DISPLAY_KEY_LABELS[mod] ?? mod[0].toUpperCase() + mod.slice(1));
  }

  const key = normalizeKey(stroke.key);
  parts.push(DISPLAY_KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)));
  return parts.join(" + ");
}

export function formatChordDisplay(chord: KeyboardChord): string {
  return normalizeChord(chord).strokes.map(formatStrokeDisplay).join(" then ");
}

export function buildKeyboardHintModel(binding: KeyboardBinding): {
  id: string;
  commandId: string;
  display: string;
  area: KeyboardArea;
  risk: KeyboardRisk;
  enabled: boolean;
  reason?: string | null;
} {
  const normalized = normalizeBinding(binding);
  return {
    id: normalized.id,
    commandId: normalized.commandId,
    display: formatChordDisplay(normalized.chord),
    area: normalized.area,
    risk: normalized.risk ?? "safe",
    enabled: normalized.enabled !== false,
    reason: normalized.enabledReason ?? null,
  };
}

// -----------------------------------------------------------------------------
// TEST-ORIENTED PURE UTILITIES
// -----------------------------------------------------------------------------

export function __private__normalizeKey(value: string): string {
  return normalizeKey(value);
}

export function __private__strokeIdentity(stroke: KeyboardStroke): string {
  return strokeIdentity(normalizeStroke(stroke));
}

export function __private__chordIdentity(chord: KeyboardChord): string {
  return chordIdentity(normalizeChord(chord));
}

export function __private__areaRank(area: KeyboardArea, context: KeyboardContext): number {
  return areaRank(area, context);
}
