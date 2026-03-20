export type AdjutorixState =
  | "IDLE"
  | "PROMPTED"
  | "PLANNED"
  | "PATCHED"
  | "REVIEWED"
  | "APPLIED"
  | "RUNNING"
  | "RESULT"
  | "FAILED";

export type AdjutorixEvent =
  | "PROMPT"
  | "PLAN_OK"
  | "PLAN_FAIL"
  | "PATCH_OK"
  | "PATCH_FAIL"
  | "REVIEW_ACCEPT"
  | "REVIEW_REJECT"
  | "APPLY_OK"
  | "APPLY_FAIL"
  | "RUN_START"
  | "RUN_OK"
  | "RUN_FAIL"
  | "RESET";

export type Transition = { from: AdjutorixState; event: AdjutorixEvent; to: AdjutorixState };

export const TRANSITIONS: readonly Transition[] = [
  { from: "IDLE", event: "PROMPT", to: "PROMPTED" },

  { from: "PROMPTED", event: "PLAN_OK", to: "PLANNED" },
  { from: "PROMPTED", event: "PLAN_FAIL", to: "FAILED" },

  { from: "PLANNED", event: "PATCH_OK", to: "PATCHED" },
  { from: "PLANNED", event: "PATCH_FAIL", to: "FAILED" },

  { from: "PATCHED", event: "REVIEW_ACCEPT", to: "REVIEWED" },
  { from: "PATCHED", event: "REVIEW_REJECT", to: "PLANNED" },

  { from: "REVIEWED", event: "APPLY_OK", to: "APPLIED" },
  { from: "REVIEWED", event: "APPLY_FAIL", to: "FAILED" },

  { from: "APPLIED", event: "RUN_START", to: "RUNNING" },

  { from: "RUNNING", event: "RUN_OK", to: "RESULT" },
  { from: "RUNNING", event: "RUN_FAIL", to: "FAILED" },

  { from: "RESULT", event: "RESET", to: "IDLE" },
  { from: "FAILED", event: "RESET", to: "IDLE" }
] as const;
