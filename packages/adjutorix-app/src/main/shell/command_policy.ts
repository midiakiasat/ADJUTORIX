export type CommandPolicyDisposition = "allow" | "confirm" | "deny";

export type CommandPolicyRisk =
  | "read-only"
  | "workspace-mutation"
  | "environment-mutation"
  | "network"
  | "destructive"
  | "privilege"
  | "unknown";

export interface CommandPolicyRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly disposition: CommandPolicyDisposition;
  readonly risk: CommandPolicyRisk;
  readonly reason: string;
}

export interface CommandPolicyDecision {
  readonly disposition: CommandPolicyDisposition;
  readonly risks: readonly CommandPolicyRisk[];
  readonly matchedRuleIds: readonly string[];
  readonly reasons: readonly string[];
  readonly normalizedCommand: string;
}

const DEFAULT_RULES: readonly CommandPolicyRule[] = [
  {
    id: "deny-destructive-root-delete",
    pattern: /\brm\s+-rf\s+\/($|\s)/,
    disposition: "deny",
    risk: "destructive",
    reason: "Refuses root-destructive deletion patterns."
  },
  {
    id: "deny-privilege-escalation",
    pattern: /\bsudo\b/,
    disposition: "deny",
    risk: "privilege",
    reason: "Refuses privilege escalation from the application shell surface."
  },
  {
    id: "deny-shell-pipe-installer",
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/,
    disposition: "deny",
    risk: "network",
    reason: "Refuses streamed remote shell execution."
  },
  {
    id: "confirm-workspace-mutation",
    pattern: /\b(git\s+(commit|push|reset|clean)|mv|cp|sed|perl|python\s+.*-c|node\s+.*-e)\b/,
    disposition: "confirm",
    risk: "workspace-mutation",
    reason: "Requires operator confirmation for repository mutation surfaces."
  },
  {
    id: "confirm-environment-mutation",
    pattern: /\b(export|unset|launchctl|defaults\s+write|chmod|chown)\b/,
    disposition: "confirm",
    risk: "environment-mutation",
    reason: "Requires confirmation for environment mutation and executable bit changes."
  },
  {
    id: "confirm-network",
    pattern: /\b(curl|wget|gh|npm\s+publish|pnpm\s+publish)\b/,
    disposition: "confirm",
    risk: "network",
    reason: "Requires confirmation for outbound network-capable command paths."
  },
  {
    id: "allow-read-only",
    pattern: /\b(cat|sed\s+-n|grep|rg|find|ls|tree|git\s+(status|diff|log|show|rev-parse|fetch))\b/,
    disposition: "allow",
    risk: "read-only",
    reason: "Allows read-only repository inspection commands."
  }
];

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function evaluateCommandPolicy(
  command: string,
  rules: readonly CommandPolicyRule[] = DEFAULT_RULES
): CommandPolicyDecision {
  const normalizedCommand = normalizeCommand(command);

  if (normalizedCommand.length === 0) {
    return {
      disposition: "deny",
      risks: ["unknown"],
      matchedRuleIds: [],
      reasons: ["Refuses empty shell commands."],
      normalizedCommand
    };
  }

  const matched = rules.filter((rule) => rule.pattern.test(normalizedCommand));
  const risks = [...new Set(matched.map((rule) => rule.risk))];
  const matchedRuleIds = matched.map((rule) => rule.id);
  const reasons = matched.map((rule) => rule.reason);

  if (matched.some((rule) => rule.disposition === "deny")) {
    return {
      disposition: "deny",
      risks,
      matchedRuleIds,
      reasons,
      normalizedCommand
    };
  }

  if (matched.some((rule) => rule.disposition === "confirm")) {
    return {
      disposition: "confirm",
      risks,
      matchedRuleIds,
      reasons,
      normalizedCommand
    };
  }

  if (matched.length > 0) {
    return {
      disposition: "allow",
      risks,
      matchedRuleIds,
      reasons,
      normalizedCommand
    };
  }

  return {
    disposition: "confirm",
    risks: ["unknown"],
    matchedRuleIds: [],
    reasons: ["Unknown command surface requires explicit operator confirmation."],
    normalizedCommand
  };
}

export function assertCommandAllowed(decision: CommandPolicyDecision): void {
  if (decision.disposition !== "allow") {
    throw new Error(
      `command policy refused automatic execution: ${decision.disposition} :: ${decision.reasons.join(" | ")}`
    );
  }
}
