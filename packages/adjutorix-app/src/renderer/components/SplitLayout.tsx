import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  GripHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Rows3,
  Columns3,
  Maximize2,
  Minimize2,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / SplitLayout.tsx
 *
 * Canonical deterministic split-layout compositor for renderer regions.
 *
 * Purpose:
 * - provide a single authoritative pane-splitting surface for nested shell layouts
 * - unify split ratios, collapse semantics, drag resizing, bounded geometry, and
 *   pane visibility under one strict component contract
 * - prevent feature panels from compensating for inconsistent container behavior
 * - make structural layout state explicit and replayable instead of emergent from CSS hacks
 *
 * Architectural role:
 * - SplitLayout is an infrastructure component used by shell and feature regions
 * - it owns pane geometry and resize interactions, not business logic
 * - it accepts fully controlled or partially controlled state through props/callbacks
 * - it supports two-pane composition with optional nested usage for complex shells
 *
 * Hard invariants:
 * - pane ratio always remains within declared min/max bounds
 * - exactly one resize axis is active for a given layout instance
 * - collapsed pane does not consume layout ratio until restored
 * - identical props and local interaction history yield identical rendered geometry
 * - content surfaces never infer layout state; they receive it explicitly
 * - no hidden persistence, no placeholder panes, no implicit rebalancing beyond declared rules
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type SplitAxis = "horizontal" | "vertical";
export type SplitCollapseSide = "first" | "second" | "none";
export type SplitDensity = "comfortable" | "compact" | "dense";

export type SplitBounds = {
  minRatio: number;
  maxRatio: number;
};

export type SplitChromeMode = "full" | "minimal" | "hidden";

export type SplitLayoutProps = {
  id?: string;
  axis?: SplitAxis;
  ratio?: number;
  defaultRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  collapsedSide?: SplitCollapseSide;
  defaultCollapsedSide?: SplitCollapseSide;
  firstLabel?: string;
  secondLabel?: string;
  density?: SplitDensity;
  chromeMode?: SplitChromeMode;
  resizable?: boolean;
  allowCollapse?: boolean;
  persistHint?: boolean;
  firstPane: React.ReactNode;
  secondPane: React.ReactNode;
  firstVisible?: boolean;
  secondVisible?: boolean;
  firstPreferredPx?: number;
  secondPreferredPx?: number;
  onRatioChange?: (ratio: number) => void;
  onCollapseChange?: (side: SplitCollapseSide) => void;
  onResizeStart?: () => void;
  onResizeEnd?: (ratio: number) => void;
  onToggleCollapse?: (side: Exclude<SplitCollapseSide, "none">) => void;
  className?: string;
  paneClassName?: string;
  dividerClassName?: string;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRatio(ratio: number | undefined, fallback: number, min: number, max: number): number {
  return clamp(typeof ratio === "number" && Number.isFinite(ratio) ? ratio : fallback, min, max);
}

function normalizeCollapse(value: SplitCollapseSide | undefined, fallback: SplitCollapseSide): SplitCollapseSide {
  return value === "first" || value === "second" || value === "none" ? value : fallback;
}

function densityClasses(density: SplitDensity): { padding: string; handle: string } {
  switch (density) {
    case "dense":
      return { padding: "p-1", handle: "h-8 w-8" };
    case "compact":
      return { padding: "p-1.5", handle: "h-9 w-9" };
    default:
      return { padding: "p-2", handle: "h-10 w-10" };
  }
}

function chromeVisible(mode: SplitChromeMode): boolean {
  return mode !== "hidden";
}

function panePercentages(ratio: number, collapsed: SplitCollapseSide): { first: string; second: string } {
  if (collapsed === "first") return { first: "0%", second: "100%" };
  if (collapsed === "second") return { first: "100%", second: "0%" };
  return {
    first: `${(ratio * 100).toFixed(4)}%`,
    second: `${((1 - ratio) * 100).toFixed(4)}%`,
  };
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function SplitHeader(props: {
  axis: SplitAxis;
  firstLabel: string;
  secondLabel: string;
  collapsedSide: SplitCollapseSide;
  allowCollapse: boolean;
  onToggleCollapse?: (side: Exclude<SplitCollapseSide, "none">) => void;
  chromeMode: SplitChromeMode;
  density: SplitDensity;
}): JSX.Element | null {
  if (!chromeVisible(props.chromeMode)) return null;

  const compact = props.chromeMode === "minimal";

  return (
    <div className={cx("flex items-center justify-between border-b border-zinc-800 bg-zinc-950/70", compact ? "px-3 py-2" : "px-4 py-3")}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-2 text-zinc-300">
          {props.axis === "horizontal" ? <Columns3 className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Split layout</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
            <span className={cx(props.collapsedSide === "first" && "opacity-50")}>{props.firstLabel}</span>
            <span className="text-zinc-600">↔</span>
            <span className={cx(props.collapsedSide === "second" && "opacity-50")}>{props.secondLabel}</span>
          </div>
        </div>
      </div>

      {props.allowCollapse ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => props.onToggleCollapse?.("first")}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            {props.axis === "horizontal" ? (
              props.collapsedSide === "first" ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />
            ) : props.collapsedSide === "first" ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={() => props.onToggleCollapse?.("second")}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            {props.axis === "horizontal" ? (
              props.collapsedSide === "second" ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />
            ) : props.collapsedSide === "second" ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DividerHandle(props: {
  axis: SplitAxis;
  dragging: boolean;
  density: SplitDensity;
  resizable: boolean;
  className?: string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}): JSX.Element | null {
  const sizing = densityClasses(props.density);
  if (!props.resizable) return null;

  return (
    <div
      role="separator"
      aria-orientation={props.axis === "horizontal" ? "vertical" : "horizontal"}
      onPointerDown={props.onPointerDown}
      className={cx(
        "relative z-10 shrink-0 select-none",
        props.axis === "horizontal"
          ? "w-3 cursor-col-resize bg-transparent"
          : "h-3 cursor-row-resize bg-transparent",
        props.className,
      )}
    >
      <div
        className={cx(
          "absolute inset-0 flex items-center justify-center",
          props.axis === "horizontal" ? "top-0 h-full" : "left-0 w-full",
        )}
      >
        <div
          className={cx(
            "flex items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/95 text-zinc-300 shadow-lg transition",
            sizing.handle,
            props.dragging && "border-indigo-700/40 bg-indigo-500/15 text-indigo-200",
          )}
        >
          {props.axis === "horizontal" ? <GripVertical className="h-4 w-4" /> : <GripHorizontal className="h-4 w-4" />}
        </div>
      </div>
    </div>
  );
}

function PaneChrome(props: {
  title: string;
  collapsed: boolean;
  axis: SplitAxis;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={cx("flex h-full min-h-0 min-w-0 flex-col rounded-[1.5rem] border border-zinc-800 bg-zinc-900/60 shadow-sm", props.className)}>
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Pane</div>
          <div className="mt-1 truncate text-sm font-medium text-zinc-100">{props.title}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-2 text-zinc-400">
          {props.axis === "horizontal" ? (props.collapsed ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />) : props.collapsed ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">{props.children}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function SplitLayout(props: SplitLayoutProps): JSX.Element {
  const axis = props.axis ?? "horizontal";
  const minRatio = props.minRatio ?? 0.15;
  const maxRatio = props.maxRatio ?? 0.85;
  const controlledRatio = typeof props.ratio === "number";
  const controlledCollapsed = typeof props.collapsedSide !== "undefined";
  const density = props.density ?? "comfortable";
  const chromeMode = props.chromeMode ?? "full";
  const resizable = props.resizable ?? true;
  const allowCollapse = props.allowCollapse ?? true;
  const firstVisible = props.firstVisible ?? true;
  const secondVisible = props.secondVisible ?? true;

  const [uncontrolledRatio, setUncontrolledRatio] = useState<number>(() =>
    normalizeRatio(props.defaultRatio, 0.5, minRatio, maxRatio),
  );
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<SplitCollapseSide>(() =>
    normalizeCollapse(props.defaultCollapsedSide, "none"),
  );
  const [dragging, setDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const ratio = normalizeRatio(controlledRatio ? props.ratio : uncontrolledRatio, 0.5, minRatio, maxRatio);
  const collapsedSide = normalizeCollapse(controlledCollapsed ? props.collapsedSide : uncontrolledCollapsed, "none");

  const effectiveCollapsed: SplitCollapseSide = useMemo(() => {
    if (!firstVisible && !secondVisible) return "none";
    if (!firstVisible) return "first";
    if (!secondVisible) return "second";
    return collapsedSide;
  }, [collapsedSide, firstVisible, secondVisible]);

  const sizes = panePercentages(ratio, effectiveCollapsed);

  const commitRatio = useCallback(
    (next: number) => {
      const normalized = normalizeRatio(next, 0.5, minRatio, maxRatio);
      if (!controlledRatio) setUncontrolledRatio(normalized);
      props.onRatioChange?.(normalized);
      return normalized;
    },
    [controlledRatio, maxRatio, minRatio, props],
  );

  const commitCollapsed = useCallback(
    (side: SplitCollapseSide) => {
      const normalized = normalizeCollapse(side, "none");
      if (!controlledCollapsed) setUncontrolledCollapsed(normalized);
      props.onCollapseChange?.(normalized);
      return normalized;
    },
    [controlledCollapsed, props],
  );

  const toggleCollapse = useCallback(
    (side: Exclude<SplitCollapseSide, "none">) => {
      const next = effectiveCollapsed === side ? "none" : side;
      commitCollapsed(next);
      props.onToggleCollapse?.(side);
    },
    [commitCollapsed, effectiveCollapsed, props],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizable || effectiveCollapsed !== "none") return;
      if (!containerRef.current) return;

      pointerIdRef.current = event.pointerId;
      setDragging(true);
      props.onResizeStart?.();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [effectiveCollapsed, props, resizable],
  );

  useEffect(() => {
    if (!dragging) return;

    const onPointerMove = (event: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (axis === "horizontal") {
        const next = (event.clientX - rect.left) / rect.width;
        commitRatio(next);
      } else {
        const next = (event.clientY - rect.top) / rect.height;
        commitRatio(next);
      }
    };

    const onPointerUp = () => {
      setDragging(false);
      props.onResizeEnd?.(ratio);
      pointerIdRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [axis, commitRatio, dragging, props, ratio]);

  return (
    <section className={cx("flex h-full min-h-0 min-w-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-950/60 shadow-xl", props.className)}>
      <SplitHeader
        axis={axis}
        firstLabel={props.firstLabel ?? "Primary pane"}
        secondLabel={props.secondLabel ?? "Secondary pane"}
        collapsedSide={effectiveCollapsed}
        allowCollapse={allowCollapse}
        onToggleCollapse={toggleCollapse}
        chromeMode={chromeMode}
        density={density}
      />

      <div
        ref={containerRef}
        className={cx(
          "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
          axis === "horizontal" ? "flex-row" : "flex-col",
          densityClasses(density).padding,
        )}
      >
        <motion.div
          layout
          style={axis === "horizontal" ? { width: sizes.first } : { height: sizes.first }}
          className={cx("min-h-0 min-w-0 overflow-hidden", effectiveCollapsed === "first" && "pointer-events-none")}
        >
          <PaneChrome title={props.firstLabel ?? "Primary pane"} collapsed={effectiveCollapsed === "first"} axis={axis} className={props.paneClassName}>
            {firstVisible ? props.firstPane : null}
          </PaneChrome>
        </motion.div>

        {firstVisible && secondVisible ? (
          <DividerHandle
            axis={axis}
            dragging={dragging}
            density={density}
            resizable={resizable}
            className={props.dividerClassName}
            onPointerDown={onPointerDown}
          />
        ) : null}

        <motion.div
          layout
          style={axis === "horizontal" ? { width: sizes.second } : { height: sizes.second }}
          className={cx("min-h-0 min-w-0 overflow-hidden", effectiveCollapsed === "second" && "pointer-events-none")}
        >
          <PaneChrome title={props.secondLabel ?? "Secondary pane"} collapsed={effectiveCollapsed === "second"} axis={axis} className={props.paneClassName}>
            {secondVisible ? props.secondPane : null}
          </PaneChrome>
        </motion.div>
      </div>

      {chromeVisible(chromeMode) ? (
        <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1">
              {axis === "horizontal" ? <Columns3 className="h-3.5 w-3.5" /> : <Rows3 className="h-3.5 w-3.5" />}
              axis: {axis}
            </span>
            <span>ratio: {(ratio * 100).toFixed(1)}%</span>
            <span>collapsed: {effectiveCollapsed}</span>
            <span>bounds: {minRatio.toFixed(2)}–{maxRatio.toFixed(2)}</span>
            {props.persistHint ? <span>persist-hint enabled</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------
// OPTIONAL COMPOSABLE PRIMITIVES
// -----------------------------------------------------------------------------

export function SplitPlaceholderCard(props: { title: string; description: string }): JSX.Element {
  return (
    <div className="grid h-full min-h-[16rem] place-items-center p-6 text-center">
      <div className="max-w-lg rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60 text-zinc-400">
          <Columns3 className="h-5 w-5" />
        </div>
        <h3 className="mt-5 text-lg font-semibold text-zinc-100">{props.title}</h3>
        <p className="mt-3 text-sm leading-7 text-zinc-500">{props.description}</p>
      </div>
    </div>
  );
}
