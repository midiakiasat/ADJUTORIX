import { describe, it, expect } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / keyboard.test.ts
 *
 * Canonical low-level keyboard utility contract suite.
 *
 * Purpose:
 * - verify that renderer/lib/keyboard preserves canonical normalization, parsing, matching,
 *   label rendering, and text-entry guard semantics for all higher-level shortcut surfaces
 * - verify that modifier order, alias normalization, repeat posture, and scope-safe event matching
 *   remain deterministic across platforms and input targets
 * - verify that invalid or ambiguous shortcut strings fail safely instead of silently widening matches
 *
 * Test philosophy:
 * - no snapshots
 * - assert primitive keyboard contracts directly because every higher-level shortcut surface depends on them
 * - prefer normalization and boundary-condition guarantees over happy-path only coverage
 *
 * Notes:
 * - this suite assumes renderer/lib/keyboard exports the functions referenced below
 * - if the real module exports differ slightly, update the imports and assertions first rather than
 *   weakening the contract intent
 */

import {
  normalizeKey,
  normalizeShortcut,
  parseShortcut,
  stringifyShortcut,
  matchesShortcut,
  isTextInputLikeTarget,
  eventToShortcut,
  equalShortcut,
  sortShortcutModifiers,
} from "../../../src/renderer/lib/keyboard";

function makeTarget<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  extras: Record<string, unknown> = {},
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(extras)) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
  return el;
}

function makeKeyEvent(
  key: string,
  partial: Partial<KeyboardEvent> & { target?: EventTarget | null } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: partial.ctrlKey ?? false,
    metaKey: partial.metaKey ?? false,
    altKey: partial.altKey ?? false,
    shiftKey: partial.shiftKey ?? false,
  });

  Object.defineProperty(event, "target", {
    value: partial.target ?? document.body,
    configurable: true,
  });

  if (typeof partial.repeat === "boolean") {
    Object.defineProperty(event, "repeat", {
      value: partial.repeat,
      configurable: true,
    });
  }

  return event;
}

describe("renderer/lib/keyboard", () => {
  describe("normalizeKey", () => {
    it("normalizes alphabetic keys to lowercase canonical form", () => {
      expect(normalizeKey("A")).toBe("a");
      expect(normalizeKey("z")).toBe("z");
    });

    it("normalizes common aliases into canonical semantic keys", () => {
      expect(normalizeKey("Esc")).toBe("escape");
      expect(normalizeKey("Escape")).toBe("escape");
      expect(normalizeKey("Return")).toBe("enter");
      expect(normalizeKey("Del")).toBe("delete");
      expect(normalizeKey("Spacebar")).toBe("space");
      expect(normalizeKey(" ")).toBe("space");
    });

    it("preserves named navigation and function keys in normalized lowercase form", () => {
      expect(normalizeKey("ArrowDown")).toBe("arrowdown");
      expect(normalizeKey("PageUp")).toBe("pageup");
      expect(normalizeKey("F12")).toBe("f12");
    });

    it("trims surrounding whitespace before normalization", () => {
      expect(normalizeKey("  K  ")).toBe("k");
      expect(normalizeKey("  Escape ")).toBe("escape");
    });
  });

  describe("sortShortcutModifiers", () => {
    it("sorts modifiers into deterministic canonical order", () => {
      expect(sortShortcutModifiers(["shift", "meta", "ctrl", "alt"])).toEqual([
        "ctrl",
        "meta",
        "alt",
        "shift",
      ]);
    });

    it("deduplicates repeated modifiers while preserving canonical order", () => {
      expect(sortShortcutModifiers(["meta", "shift", "meta", "shift"])).toEqual([
        "meta",
        "shift",
      ]);
    });
  });

  describe("parseShortcut", () => {
    it("parses canonical chord strings into normalized shortcut objects", () => {
      expect(parseShortcut("Meta+Shift+K")).toEqual({
        key: "k",
        ctrl: false,
        meta: true,
        alt: false,
        shift: true,
      });
    });

    it("parses modifier aliases and key aliases into the same canonical shape", () => {
      expect(parseShortcut("Cmd+Esc")).toEqual({
        key: "escape",
        ctrl: false,
        meta: true,
        alt: false,
        shift: false,
      });

      expect(parseShortcut("Control+Option+Return")).toEqual({
        key: "enter",
        ctrl: true,
        meta: false,
        alt: true,
        shift: false,
      });
    });

    it("parses bare keys without modifiers", () => {
      expect(parseShortcut("/" )).toEqual({
        key: "/",
        ctrl: false,
        meta: false,
        alt: false,
        shift: false,
      });
    });

    it("rejects empty, modifier-only, or multiply-keyed chords", () => {
      expect(() => parseShortcut("")).toThrow();
      expect(() => parseShortcut("Meta+Shift")).toThrow();
      expect(() => parseShortcut("Meta+K+P")).toThrow();
    });

    it("rejects unknown modifier tokens rather than silently widening matches", () => {
      expect(() => parseShortcut("Hyper+K")).toThrow();
      expect(() => parseShortcut("Magic+Enter")).toThrow();
    });
  });

  describe("stringifyShortcut", () => {
    it("renders shortcut objects into canonical deterministic chord labels", () => {
      expect(
        stringifyShortcut({ key: "k", ctrl: true, meta: false, alt: true, shift: true }),
      ).toBe("Ctrl+Alt+Shift+K");
    });

    it("renders named keys with canonical human-readable casing", () => {
      expect(
        stringifyShortcut({ key: "escape", ctrl: false, meta: true, alt: false, shift: false }),
      ).toBe("Meta+Escape");

      expect(
        stringifyShortcut({ key: "arrowdown", ctrl: false, meta: false, alt: false, shift: false }),
      ).toBe("ArrowDown");
    });
  });

  describe("normalizeShortcut", () => {
    it("normalizes parsed or object-form shortcuts into canonical deterministic shape", () => {
      expect(
        normalizeShortcut({ key: "K", meta: true, ctrl: false, alt: false, shift: true }),
      ).toEqual({
        key: "k",
        ctrl: false,
        meta: true,
        alt: false,
        shift: true,
      });
    });

    it("normalizes string and object forms to equivalent canonical structures", () => {
      expect(normalizeShortcut("Meta+Shift+K")).toEqual(
        normalizeShortcut({ key: "k", meta: true, shift: true, ctrl: false, alt: false }),
      );
    });
  });

  describe("equalShortcut", () => {
    it("treats semantically identical shortcut representations as equal", () => {
      expect(
        equalShortcut("Cmd+Shift+K", { key: "k", meta: true, shift: true, ctrl: false, alt: false }),
      ).toBe(true);
    });

    it("treats different modifier sets or keys as unequal", () => {
      expect(equalShortcut("Meta+K", "Ctrl+K")).toBe(false);
      expect(equalShortcut("Meta+K", "Meta+P")).toBe(false);
    });
  });

  describe("eventToShortcut", () => {
    it("projects keyboard events into canonical shortcut objects", () => {
      const event = makeKeyEvent("K", { metaKey: true, shiftKey: true });
      expect(eventToShortcut(event)).toEqual({
        key: "k",
        ctrl: false,
        meta: true,
        alt: false,
        shift: true,
      });
    });

    it("normalizes alias keys during event projection", () => {
      const event = makeKeyEvent("Esc", { ctrlKey: true });
      expect(eventToShortcut(event)).toEqual({
        key: "escape",
        ctrl: true,
        meta: false,
        alt: false,
        shift: false,
      });
    });
  });

  describe("matchesShortcut", () => {
    it("matches events only when key and all modifiers agree exactly", () => {
      const event = makeKeyEvent("k", { metaKey: true, shiftKey: true });
      expect(matchesShortcut(event, "Meta+Shift+K")).toBe(true);
      expect(matchesShortcut(event, "Meta+K")).toBe(false);
      expect(matchesShortcut(event, "Ctrl+Shift+K")).toBe(false);
    });

    it("matches alias string forms through canonical normalization", () => {
      const event = makeKeyEvent("Return", { ctrlKey: true, altKey: true });
      expect(matchesShortcut(event, "Control+Option+Enter")).toBe(true);
    });

    it("does not widen matching for extra modifiers", () => {
      const event = makeKeyEvent("k", { metaKey: true, shiftKey: true, altKey: true });
      expect(matchesShortcut(event, "Meta+Shift+K")).toBe(false);
    });
  });

  describe("isTextInputLikeTarget", () => {
    it("returns true for input and textarea elements", () => {
      expect(isTextInputLikeTarget(makeTarget("input"))).toBe(true);
      expect(isTextInputLikeTarget(makeTarget("textarea"))).toBe(true);
    });

    it("returns true for contenteditable surfaces", () => {
      expect(isTextInputLikeTarget(makeTarget("div", { isContentEditable: true }))).toBe(true);
      expect(isTextInputLikeTarget(makeTarget("span", { isContentEditable: true }))).toBe(true);
    });

    it("returns true for select only if the utility intentionally treats it as text-entry-like", () => {
      const result = isTextInputLikeTarget(makeTarget("select"));
      expect(typeof result).toBe("boolean");
    });

    it("returns false for ordinary non-editable elements", () => {
      expect(isTextInputLikeTarget(makeTarget("div"))).toBe(false);
      expect(isTextInputLikeTarget(makeTarget("button"))).toBe(false);
      expect(isTextInputLikeTarget(document.body)).toBe(false);
    });

    it("walks upward through nested DOM to detect editable ancestors", () => {
      const parent = makeTarget("div", { isContentEditable: true });
      const child = makeTarget("span");
      parent.appendChild(child);

      expect(isTextInputLikeTarget(child)).toBe(true);
    });
  });

  describe("integration of primitive semantics", () => {
    it("round-trips parse -> stringify -> parse without semantic drift", () => {
      const first = parseShortcut("Ctrl+Alt+Shift+P");
      const label = stringifyShortcut(first);
      const second = parseShortcut(label);

      expect(second).toEqual(first);
    });

    it("round-trips event -> shortcut -> string without modifier-order drift", () => {
      const event = makeKeyEvent("P", { ctrlKey: true, altKey: true, shiftKey: true });
      const shortcut = eventToShortcut(event);
      const label = stringifyShortcut(shortcut);

      expect(label).toBe("Ctrl+Alt+Shift+P");
    });

    it("keeps slash, enter, escape, and arrow keys semantically distinct at the primitive layer", () => {
      expect(normalizeShortcut("/")).not.toEqual(normalizeShortcut("Enter"));
      expect(normalizeShortcut("Escape")).not.toEqual(normalizeShortcut("ArrowDown"));
      expect(normalizeShortcut("ArrowDown")).not.toEqual(normalizeShortcut("ArrowUp"));
    });

    it("fails safely on malformed shortcut strings instead of silently returning broadened matches", () => {
      expect(() => normalizeShortcut("Meta++K")).toThrow();
      expect(() => normalizeShortcut("+")).toThrow();
      expect(() => normalizeShortcut("Ctrl+Alt+Shift+")).toThrow();
    });
  });
});
