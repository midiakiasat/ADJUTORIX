import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / use_keyboard_shortcuts.test.ts
 *
 * Canonical useKeyboardShortcuts hook contract suite.
 *
 * Purpose:
 * - verify that useKeyboardShortcuts preserves one authoritative renderer-side shortcut dispatch surface
 * - verify that scope, enabled/disabled state, text-entry suppression, modifier matching,
 *   preventDefault behavior, and handler freshness remain deterministic
 * - verify that privileged or dangerous actions cannot fire when visibility, trust, or capability gates close
 * - verify that registration and cleanup are stable across rerenders and unmounts
 *
 * Test philosophy:
 * - no implementation snapshots
 * - assert keyboard dispatch semantics and event-guard invariants directly
 * - prefer scope and authority guarantees over superficial key-match happy paths
 *
 * Notes:
 * - this suite assumes useKeyboardShortcuts exports both a named and default hook from the renderer hooks tree
 * - if the production hook signature evolves, update fixture builders first
 */

import useKeyboardShortcuts, {
  type KeyboardShortcut,
  type KeyboardShortcutScope,
} from "../../../src/hooks/useKeyboardShortcuts";

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

  return event;
}

function inputTarget(tagName: string, extras: Record<string, unknown> = {}): HTMLElement {
  const el = document.createElement(tagName);
  Object.entries(extras).forEach(([key, value]) => {
    Object.defineProperty(el, key, { value, configurable: true });
  });
  return el;
}

function shortcut(
  partial: Partial<KeyboardShortcut> & Pick<KeyboardShortcut, "id" | "key" | "handler">,
): KeyboardShortcut {
  return {
    scope: "global",
    description: partial.id,
    enabled: true,
    preventDefault: true,
    allowInTextInput: false,
    requireTrusted: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    ...partial,
  } as KeyboardShortcut;
}

describe("useKeyboardShortcuts", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    addSpy = vi.spyOn(window, "addEventListener");
    removeSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("registers exactly one keydown listener on mount and removes it on unmount", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "open-workspace", key: "o", meta: true, handler })],
      }),
    );

    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function), expect.anything());

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), expect.anything());
  });

  it("dispatches a matching shortcut with exact modifier semantics and prevents default by default", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "open-workspace", key: "o", meta: true, handler })],
      }),
    );

    const event = makeKeyEvent("o", { metaKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when modifiers do not match exactly", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "open-workspace", key: "o", meta: true, handler })],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("o", { ctrlKey: true }));
      window.dispatchEvent(makeKeyEvent("o", { metaKey: true, shiftKey: true }));
      window.dispatchEvent(makeKeyEvent("p", { metaKey: true }));
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("matches keys case-insensitively while preserving modifier requirements", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "run-verify", key: "v", meta: true, shift: true, handler })],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("V", { metaKey: true, shiftKey: true }));
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("suppresses dispatch inside input, textarea, and contenteditable targets by default", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "open-palette", key: "k", meta: true, handler })],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true, target: inputTarget("input") }));
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true, target: inputTarget("textarea") }));
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true, target: inputTarget("div", { isContentEditable: true }) }));
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("allows dispatch inside text-entry targets only when allowInTextInput is true", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "send-chat", key: "Enter", meta: true, allowInTextInput: true, handler })],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("Enter", { metaKey: true, target: inputTarget("textarea") }));
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch disabled shortcuts even when key and scope match", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "apply-patch", key: "a", meta: true, shift: true, enabled: false, handler })],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("a", { metaKey: true, shiftKey: true }));
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches only shortcuts whose scope is active", () => {
    const globalHandler = vi.fn();
    const editorHandler = vi.fn();
    const terminalHandler = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        activeScopes: ["global", "editor"],
        shortcuts: [
          shortcut({ id: "global-refresh", key: "r", meta: true, handler: globalHandler, scope: "global" }),
          shortcut({ id: "editor-format", key: "f", meta: true, shift: true, handler: editorHandler, scope: "editor" }),
          shortcut({ id: "terminal-cancel", key: "c", ctrl: true, handler: terminalHandler, scope: "terminal" }),
        ],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("r", { metaKey: true }));
      window.dispatchEvent(makeKeyEvent("f", { metaKey: true, shiftKey: true }));
      window.dispatchEvent(makeKeyEvent("c", { ctrlKey: true }));
    });

    expect(globalHandler).toHaveBeenCalledTimes(1);
    expect(editorHandler).toHaveBeenCalledTimes(1);
    expect(terminalHandler).not.toHaveBeenCalled();
  });

  it("treats missing activeScopes as global-only unless otherwise specified by hook contract inputs", () => {
    const globalHandler = vi.fn();
    const editorHandler = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [
          shortcut({ id: "palette", key: "k", meta: true, handler: globalHandler, scope: "global" }),
          shortcut({ id: "editor-only", key: "e", meta: true, handler: editorHandler, scope: "editor" }),
        ],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true }));
      window.dispatchEvent(makeKeyEvent("e", { metaKey: true }));
    });

    expect(globalHandler).toHaveBeenCalledTimes(1);
    expect(editorHandler).not.toHaveBeenCalled();
  });

  it("supports trusted-only shortcut gating so privileged actions cannot fire when trust is insufficient", () => {
    const handler = vi.fn();

    const { rerender } = renderHook(
      ({ trusted }: { trusted: boolean }) =>
        useKeyboardShortcuts({
          isTrusted: trusted,
          shortcuts: [shortcut({ id: "dangerous-apply", key: "a", meta: true, shift: true, requireTrusted: true, handler })],
        }),
      { initialProps: { trusted: false } },
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("a", { metaKey: true, shiftKey: true }));
    });
    expect(handler).not.toHaveBeenCalled();

    rerender({ trusted: true });

    act(() => {
      window.dispatchEvent(makeKeyEvent("a", { metaKey: true, shiftKey: true }));
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps handlers fresh across rerenders instead of capturing stale closures", () => {
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = renderHook(
      ({ handler }: { handler: () => void }) =>
        useKeyboardShortcuts({
          shortcuts: [shortcut({ id: "refresh", key: "r", meta: true, handler })],
        }),
      { initialProps: { handler: first } },
    );

    rerender({ handler: second });

    act(() => {
      window.dispatchEvent(makeKeyEvent("r", { metaKey: true }));
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not multiply listeners or duplicate dispatch across rerenders", () => {
    const handler = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useKeyboardShortcuts({
          shortcuts: [shortcut({ id: "palette", key: "k", meta: true, enabled, handler })],
        }),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: true });
    rerender({ enabled: true });

    act(() => {
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true }));
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports preventDefault=false for shortcuts that should not consume native browser behavior", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "soft-help", key: "/", handler, preventDefault: false })],
      }),
    );

    const event = makeKeyEvent("/");
    const preventSpy = vi.spyOn(event, "preventDefault");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventSpy).not.toHaveBeenCalled();
  });

  it("prefers the first matching enabled shortcut deterministically when duplicates exist", () => {
    const first = vi.fn();
    const second = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [
          shortcut({ id: "first", key: "k", meta: true, handler: first }),
          shortcut({ id: "second", key: "k", meta: true, handler: second }),
        ],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true }));
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("ignores repeated keydown events when shortcut is configured as non-repeatable", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "run-once", key: "r", meta: true, repeatable: false, handler })],
      }),
    );

    const event = makeKeyEvent("r", { metaKey: true });
    Object.defineProperty(event, "repeat", { value: true, configurable: true });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("allows repeated keydown events when shortcut is configured as repeatable", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "move-selection", key: "ArrowDown", repeatable: true, handler })],
      }),
    );

    const event = makeKeyEvent("ArrowDown");
    Object.defineProperty(event, "repeat", { value: true, configurable: true });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports composite active scopes and nested operational contexts deterministically", () => {
    const palette = vi.fn();
    const chat = vi.fn();
    const review = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        activeScopes: ["global", "chat", "patch-review"],
        shortcuts: [
          shortcut({ id: "palette", key: "k", meta: true, handler: palette, scope: "global" }),
          shortcut({ id: "chat-send", key: "Enter", meta: true, handler: chat, scope: "chat", allowInTextInput: true }),
          shortcut({ id: "review-approve", key: "y", meta: true, handler: review, scope: "patch-review", requireTrusted: false }),
        ],
      }),
    );

    act(() => {
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true }));
      window.dispatchEvent(makeKeyEvent("Enter", { metaKey: true, target: inputTarget("textarea") }));
      window.dispatchEvent(makeKeyEvent("y", { metaKey: true }));
    });

    expect(palette).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch after unmount even if key events continue arriving", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts({
        shortcuts: [shortcut({ id: "palette", key: "k", meta: true, handler })],
      }),
    );

    unmount();

    act(() => {
      window.dispatchEvent(makeKeyEvent("k", { metaKey: true }));
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
