import React, { useMemo, useState } from "react";

type OperatorSurfaceSpinePanelProps = {
  missionControl: React.ReactNode;
  liveKernelCockpit: React.ReactNode;
  executionRunway: React.ReactNode;
};

type SpineStep = {
  id: "mission-control" | "live-kernel" | "execution-runway" | "evidence-finality";
  label: string;
  invariant: string;
  posture: "authority" | "receipt" | "execution" | "finality";
};

const SPINE_STEPS: SpineStep[] = [
  {
    id: "mission-control",
    label: "Mission Control",
    invariant: "The operator sees the whole governed operation before execution.",
    posture: "authority",
  },
  {
    id: "live-kernel",
    label: "Live Kernel",
    invariant: "Every mutation path must carry operator-kernel receipt evidence.",
    posture: "receipt",
  },
  {
    id: "execution-runway",
    label: "Execution Runway",
    invariant: "Apply, verify, and release are staged through one visible runway.",
    posture: "execution",
  },
  {
    id: "evidence-finality",
    label: "Evidence + Finality",
    invariant: "No surface is accepted unless its proof path is visible and replayable.",
    posture: "finality",
  },
];

function postureClass(posture: SpineStep["posture"], active: boolean): string {
  const base = active ? "border-emerald-600 bg-emerald-950/35 text-emerald-100" : "border-zinc-800 bg-black text-zinc-400";

  if (posture === "authority") return `${base} shadow-[0_0_0_1px_rgba(16,185,129,0.10)]`;
  if (posture === "receipt") return `${base} shadow-[0_0_0_1px_rgba(34,197,94,0.10)]`;
  if (posture === "execution") return `${base} shadow-[0_0_0_1px_rgba(245,245,245,0.06)]`;
  return `${base} shadow-[0_0_0_1px_rgba(251,191,36,0.10)]`;
}

export function OperatorSurfaceSpinePanel({
  missionControl,
  liveKernelCockpit,
  executionRunway,
}: OperatorSurfaceSpinePanelProps): React.JSX.Element {
  const [activeStep, setActiveStep] = useState<SpineStep["id"]>("mission-control");

  const activeSurface = useMemo(() => {
    if (activeStep === "mission-control") return missionControl;
    if (activeStep === "live-kernel") return liveKernelCockpit;
    if (activeStep === "execution-runway") return executionRunway;

    return (
      <div
        data-testid="operator-surface-spine-evidence-finality-surface"
        className="rounded-xl border border-amber-900/60 bg-amber-950/10 p-4"
      >
        <div className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-300">
          Evidence + Finality
        </div>
        <div className="mt-2 text-sm text-zinc-300">
          Release posture is not a hidden afterthought. The operator path must expose the evidence chain,
          verification posture, package posture, tag posture, release posture, and finality guard posture.
        </div>
        <div className="mt-3 grid gap-2 text-xs text-zinc-500 sm:grid-cols-3">
          <div className="rounded-lg border border-zinc-800 bg-black p-3">
            current main must be clean
          </div>
          <div className="rounded-lg border border-zinc-800 bg-black p-3">
            release tag must target verified SHA
          </div>
          <div className="rounded-lg border border-zinc-800 bg-black p-3">
            surface finality must be replayable
          </div>
        </div>
      </div>
    );
  }, [activeStep, executionRunway, liveKernelCockpit, missionControl]);

  return (
    <section
      data-testid="operator-surface-spine"
      className="border-b border-emerald-900/60 bg-[#07100c] px-3 py-3"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-300">
            ADJUTORIX_OPERATOR_SURFACE_SPINE
          </div>
          <div className="mt-1 max-w-3xl text-xs text-zinc-500">
            One governed operator path. Mission control, live kernel receipt, execution runway,
            and evidence/finality are no longer scattered user surfaces.
          </div>
        </div>

        <div
          data-testid="operator-surface-spine-posture"
          className="rounded-lg border border-emerald-800/60 bg-black px-3 py-2 text-xs text-emerald-200"
        >
          spine-required=true
        </div>
      </div>

      <div
        data-testid="operator-surface-spine-path"
        className="mb-3 grid gap-2 xl:grid-cols-4"
      >
        {SPINE_STEPS.map((step, index) => {
          const active = step.id === activeStep;

          return (
            <button
              key={step.id}
              type="button"
              data-testid={`operator-surface-spine-step-${step.id}`}
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
        data-testid="operator-surface-spine-active-surface"
        className="rounded-2xl border border-zinc-800 bg-black/60 p-2"
      >
        {activeSurface}
      </div>
    </section>
  );
}
