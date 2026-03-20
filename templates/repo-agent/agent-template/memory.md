# ADJUTORIX Agent Memory

This file is the persistent memory for this repository.
It is automatically updated by the agent after each job.

Do NOT delete.
Do NOT rewrite manually unless you know what you are doing.

---

## 1. Project Identity

Name: <PROJECT_NAME>
Type: <library | service | cli | api | app>
Primary Language: <python | typescript | node | mixed>

Purpose:
<One paragraph describing what this repository exists to do.>

---

## 2. Core Invariants (Must Always Hold)

These rules must never be violated:

- Tests must pass before merge
- Lint must pass before commit
- No secrets in repo
- No force-push to protected branches
- No unreviewed mass refactors
- All patches must be atomic

Project-specific invariants:

- <Invariant 1>
- <Invariant 2>
- <Invariant 3>

---

## 3. Architecture Summary

High-level structure:

- Entry points:
  - <path/to/main>
  - <path/to/cli>

- Core modules:
  - <module A>: <role>
  - <module B>: <role>

- External dependencies:
  - <dep>: <reason>
  - <dep>: <reason>

Execution flow:

<Describe how the system runs end-to-end.>

---

## 4. Coding Conventions

Style rules:

- Formatter: <black / prettier / ruff / eslint>
- Line length: <N>
- Naming: <snake_case / camelCase / mixed>
- Imports: <sorted / grouped>

Patterns:

- Error handling: <strategy>
- Logging: <strategy>
- Config loading: <strategy>

Forbidden patterns:

- Global mutable state
- Silent exception swallowing
- Hardcoded credentials
- Hidden side effects

---

## 5. Testing Strategy

Test framework: <pytest / jest / vitest / etc>

Test types:

- Unit: <path>
- Integration: <path>
- E2E: <path>

Coverage expectations:

- Critical paths: >= 90%
- Core logic: >= 80%

Known weak areas:

- <module>
- <module>

---

## 6. Deployment Model

Environment targets:

- local
- staging
- production

Deployment command:

<command>

Rollback command:

<command>

Critical configs:

- <file>
- <file>

---

## 7. Known Constraints

Technical limits:

- Memory: <limit>
- Runtime: <limit>
- API limits: <limit>

Business constraints:

- <constraint>
- <constraint>

Security constraints:

- No outbound network by default
- No credential storage in repo
- All secrets via env

---

## 8. Historical Decisions (Summary)

Important architectural decisions:

- YYYY-MM-DD: <decision> → <reason>
- YYYY-MM-DD: <decision> → <reason>

(Full details in decisions.log)

---

## 9. Active Risks

Current risks to watch:

- <risk>: <impact>
- <risk>: <impact>

Mitigation:

- <action>
- <action>

---

## 10. Open Tasks

Unfinished work:

- [ ] <task>
- [ ] <task>
- [ ] <task>

Blocked tasks:

- [ ] <task> (blocked by <reason>)

---

## 11. Agent Operating Notes

Special handling rules for this repo:

- Always run <command> before patching
- Never touch <path> without approval
- Treat <module> as critical

Preferred workflow:

1. SCAN
2. PLAN
3. PATCH
4. VERIFY
5. REPORT
6. STOP

---

## 12. Session Summaries (Auto-Generated)

### Latest Session

Date: <auto>
Objective: <auto>

Changes:
- <auto>

Results:
- <auto>

Issues:
- <auto>

Next Actions:
- <auto>

---

### Previous Sessions

(Older summaries appended automatically)

---

## 13. Metadata

Last Updated: <auto>
Updated By: ADJUTORIX Agent
Schema Version: 1.0
