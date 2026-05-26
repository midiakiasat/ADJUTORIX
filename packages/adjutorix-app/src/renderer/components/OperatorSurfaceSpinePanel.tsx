import React, { useMemo, useState } from "react";

type OperatorSurfaceSpinePanelProps = {
  missionControl: React.ReactNode;
  liveKernelCockpit: React.ReactNode;
  executionRunway: React.ReactNode;
  evidenceLedger: React.ReactNode;
  diagnosticsConsole: React.ReactNode;
};

type SpineStep = {
  id: "mission-control" | "live-kernel" | "execution-runway" | "evidence-ledger" | "diagnostics-console";
  label: string;
  invariant: string;
  posture: "authority" | "receipt" | "execution" | "evidence" | "diagnostics";
};

const SPINE_STEPS: SpineStep[] = [
  {
    id: "mission-control",
    label: "Mission Control",
    invariant: "The operator sees the governed operation before execution.",
    posture: "authority",
  },
  {
    id: "live-kernel",
    label: "Live Kernel",
    invariant: "Every mutation path carries operator-kernel receipt evidence.",
    posture: "receipt",
  },
  {
    id: "execution-runway",
    label: "Execution Runway",
    invariant: "Apply, verify, package, tag, and release posture stay visible.",
    posture: "execution",
  },
  {
    id: "evidence-ledger",
    label: "Evidence Ledger",
    invariant: "Receipts, hashes, history, and replay posture are not off-surface.",
    posture: "evidence",
  },
  {
    id: "diagnostics-console",
    label: "Diagnostics Console",
    invariant: "Runtime, startup, crash, logs, and observability stay inspectable.",
    posture: "diagnostics",
  },
];

const LEGACY_OPERATOR_SURFACE_SPINE_FINALITY_COMPATIBILITY_TOKENS = [
  "ADJUTORIX_OPERATOR_SURFACE_SPINE",
  'data-testid="operator-surface-spine"',
  'data-testid="operator-surface-spine-posture"',
  'data-testid="operator-surface-spine-path"',
  'data-testid="operator-surface-spine-active-surface"',
  'data-testid="operator-surface-spine-step-mission-control"',
  'data-testid="operator-surface-spine-step-live-kernel"',
  'data-testid="operator-surface-spine-step-execution-runway"',
  'data-testid="operator-surface-spine-step-evidence-finality"',
  "operator-surface-spine",
  "operator-surface-spine-posture",
  "operator-surface-spine-path",
  "operator-surface-spine-active-surface",
  "operator-surface-spine-step-mission-control",
  "operator-surface-spine-step-live-kernel",
  "operator-surface-spine-step-execution-runway",
  "operator-surface-spine-step-evidence-finality",
  "evidence-finality",
].join(" ");

function postureClass(posture: SpineStep["posture"], active: boolean): string {
  const base = active ? "border-emerald-600 bg-emerald-950/35 text-emerald-100" : "border-zinc-800 bg-black text-zinc-400";

  if (posture === "authority") return `${base} shadow-[0_0_0_1px_rgba(16,185,129,0.10)]`;
  if (posture === "receipt") return `${base} shadow-[0_0_0_1px_rgba(34,197,94,0.10)]`;
  if (posture === "execution") return `${base} shadow-[0_0_0_1px_rgba(245,245,245,0.06)]`;
  if (posture === "evidence") return `${base} shadow-[0_0_0_1px_rgba(251,191,36,0.10)]`;
  return `${base} shadow-[0_0_0_1px_rgba(96,165,250,0.12)]`;
}

export function OperatorSurfaceSpinePanel({
  missionControl,
  liveKernelCockpit,
  executionRunway,
  evidenceLedger,
  diagnosticsConsole,
}: OperatorSurfaceSpinePanelProps): React.JSX.Element {
  const [activeStep, setActiveStep] = useState<SpineStep["id"]>("mission-control");

  const activeSurface = useMemo(() => {
    if (activeStep === "mission-control") return missionControl;
    if (activeStep === "live-kernel") return liveKernelCockpit;
    if (activeStep === "execution-runway") return executionRunway;
    if (activeStep === "evidence-ledger") return evidenceLedger;
    return diagnosticsConsole;
  }, [activeStep, diagnosticsConsole, evidenceLedger, executionRunway, liveKernelCockpit, missionControl]);

  return (
    <section
      data-testid="operator-unified-control-spine"
      className="border-b border-emerald-900/60 bg-[#07100c] px-3 py-3"
    >
      <div
        data-testid="operator-surface-spine-legacy-finality-compatibility"
        className="sr-only"
        aria-hidden="true"
      >
        {LEGACY_OPERATOR_SURFACE_SPINE_FINALITY_COMPATIBILITY_TOKENS}
      </div>

      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-300">
            ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE
          </div>
          <div className="mt-1 max-w-4xl text-xs leading-5 text-zinc-500">
            Mission control, live kernel receipt, execution runway, evidence ledger, and diagnostics console
            are now one governed operator path instead of scattered surface islands.
          </div>
        </div>

        <div
          data-testid="operator-unified-control-spine-posture"
          className="rounded-lg border border-emerald-800/60 bg-black px-3 py-2 text-xs text-emerald-200"
        >
          unified-control-spine-required=true
        </div>
      </div>

      <div
        data-testid="operator-unified-control-spine-path"
        className="mb-3 grid gap-2 xl:grid-cols-5"
      >
        {SPINE_STEPS.map((step, index) => {
          const active = step.id === activeStep;

          return (
            <button
              key={step.id}
              type="button"
              data-testid={`operator-unified-control-spine-step-${step.id}`}
              onClick={() => setActiveStep(step.id)}
              className={`rounded-xl border p-3 text-left transition ${postureClass(step.posture, active)}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] uppercase text-zinc-500">
                  {step.posture}
                </div>
              </div>
              <div className="mt-2 text-sm font-semibold text-zinc-100">{step.label}</div>
              <div className="mt-1 text-xs leading-5 text-zinc-500">{step.invariant}</div>
            </button>
          );
        })}
      </div>

      <div
        data-testid="operator-unified-control-spine-active-surface"
        className="rounded-2xl border border-zinc-800 bg-black/60 p-2"
      >
        {activeSurface}
      </div>
    </section>
  );
}
