---
name: semantic-refactor
description: Behavior-preserving structural transformation with a behavioral safety net, step-isolated commits, and zero contract drift. Use when refactoring is the explicit task.
domain: coding
operations: [task]
---

# Semantic Refactor

Use when the task is explicitly a refactoring, structural migration, or framework upgrade that must preserve observable behavior.

`code-minimality` discourages speculative refactoring during other tasks. This skill applies when refactoring IS the task.

For a defect, use `bug-fix`. For a security vulnerability, use `security-remediation`. This skill owns behavior-preserving transformation.

## 1. Confirm refactoring is the explicit task

Before starting:

- the task brief must explicitly request refactoring, migration, or structural cleanup;
- the target behavior must be documented or testable;
- if the task does not name refactoring as the goal, do not refactor. Follow `code-minimality` section 5.

## 2. Establish a behavioral safety net

Before changing any code:

- run the existing test suite and record the green baseline;
- if test coverage is incomplete for the area being refactored, add characterization tests at the public seam before refactoring;
- a characterization test captures current observed behavior, not desired behavior;
- if no test seam exists, use a snapshot, type check, or manual verification script as the safety net;
- record what the safety net covers and what it does not.

Do not start refactoring without a safety net. The safety net is the only evidence that behavior is preserved.

## 3. Step-isolated commits

- each refactoring step is a separate commit;
- each commit leaves the code in a working state (builds, tests pass);
- do not mix refactoring with feature addition, bug fixes, or dependency upgrades in the same commit;
- do not mix refactoring with formatting or naming changes unless the rename is the refactoring goal.

## 4. Zero contract drift

After each refactoring step:

- public API inputs and outputs remain the same;
- exception types and error codes remain the same;
- side effects (file writes, network calls, state mutations) remain the same;
- type signatures remain compatible;
- the contract test or characterization test passes.

If the refactoring intentionally changes a contract, it is not a pure refactor. Follow `contract-evolution` for the contract change, and separate it from the structural refactoring.

## 5. Eliminate duplicate authority

When the refactoring goal is to consolidate duplicate logic:

- identify all duplicate sites (follow `change-impact` for consumers);
- choose one owner as the single source of truth;
- update consumers to use the owner;
- delete the duplicates (follow `code-minimality` section 3 for deletion classification);
- do not leave the old path as a "temporary fallback" unless a deprecation lifecycle is in place.

## 6. Scope discipline

- touch only the modules in the refactoring scope;
- do not opportunistically refactor nearby code that the task did not name;
- do not upgrade dependencies as part of a structural refactor unless the upgrade is the stated goal;
- if a newly discovered issue is outside scope, report it separately.

## 7. Completion

The refactoring is complete when:

- the behavioral safety net passes before and after every step;
- no public contract drifted (or contract changes follow `contract-evolution`);
- each commit is a working state;
- duplicate authority is eliminated or has a deprecation plan;
- the diff contains only refactoring, no mixed feature or bug changes.
