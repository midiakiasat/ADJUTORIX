export type GovernanceInvariantInput = Record<string, unknown>;

export type GovernanceInvariantResult = {
  ok: boolean;
  pass: boolean;
  passed: boolean;
  allowed: boolean;
  denied: boolean;
  violations: string[];
  errors: string[];
  reasons: string[];
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "approved" || value === "allow" || value === "allowed" || value === "pass" || value === "passed";
}

function text(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function result(ok: boolean, violations: string[]): GovernanceInvariantResult {
  return {
    ok,
    pass: ok,
    passed: ok,
    allowed: ok,
    denied: !ok,
    violations,
    errors: violations,
    reasons: violations,
  };
}

export function evaluateGovernanceInvariant(input: unknown = {}): GovernanceInvariantResult {
  const record = asRecord(input);
  const governance = asRecord(record.governance);
  const policy = asRecord(record.policy);
  const approval = asRecord(record.approval);

  const action = text(record.action ?? record.operation ?? record.intent ?? governance.action ?? "apply");
  const target = text(record.target ?? record.path ?? record.file ?? governance.target ?? "");

  const deniedValues = [
    ...asArray(record.denied),
    ...asArray(governance.denied),
    ...asArray(policy.denied),
    ...asArray(policy.deniedActions),
    ...asArray(policy.blockedActions),
  ].map(text);

  const explicitDeny =
    truthy(record.denied) ||
    truthy(governance.denied) ||
    text(record.decision) === "denied" ||
    text(record.status) === "denied" ||
    text(record.status) === "rejected" ||
    deniedValues.includes(action) ||
    (target.length > 0 && deniedValues.includes(target));

  const approvals = [
    record.approved,
    record.authorized,
    record.allow,
    record.allowed,
    record.approval,
    record.decision,
    record.status,
    approval.approved,
    approval.status,
    governance.approved,
    governance.allowed,
    ...asArray(record.approvals),
    ...asArray(governance.approvals),
  ];

  const approved = approvals.some(truthy);

  const requiresApproval =
    record.requiresApproval === false || governance.requiresApproval === false
      ? false
      : action.includes("apply") ||
        action.includes("write") ||
        action.includes("mutate") ||
        target.length > 0;

  const violations: string[] = [];

  if (explicitDeny) violations.push("governance denied this operation");
  if (requiresApproval && !approved) violations.push("apply requires explicit governance approval");

  return result(violations.length === 0, violations);
}

export default evaluateGovernanceInvariant;
