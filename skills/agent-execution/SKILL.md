---
name: agent-execution
description: Baseline execution discipline for coding and repository agents. Use for every engineering task.
always: true
---

# Agent Execution

Use this skill for every engineering task.

## 1. Discover context first

Before changing anything, inspect only the context relevant to the task:

1. root README / CONTRIBUTING / architecture documents;
2. repository agent instructions;
3. relevant docs, contracts, policies, and rules;
4. manifests and build/test configuration;
5. similar existing implementation when documentation is absent.

Do not recursively read unrelated trees. Do not resurrect deprecated paths.

## 2. Think before coding

Resolve what can be verified from repository evidence before making assumptions.

- State material assumptions.
- Prefer the simplest solution that satisfies the contract.
- Reuse existing responsibility boundaries before creating new abstractions.
- Surface materially different interpretations instead of silently choosing one.
- Do not invent compatibility, configurability, or fallback behavior that was not requested.

## 3. Keep changes surgical

Touch only what the task requires.

Do not:
- refactor unrelated code;
- rename unrelated symbols;
- reformat unrelated files;
- upgrade dependencies without necessity;
- add speculative abstractions;
- fix unrelated pre-existing findings.

A newly discovered issue may be changed only when the task requested it, the current change caused it, or the requested behavior cannot work without it. Otherwise report it separately.

Before adding any new source-code path (a helper, guard, branch, fallback, adapter, or owner file), state why the task cannot be met without it:

```text
Need: <what requested behavior requires it>
No-code option: <why docs, config, or reuse cannot cover it>
Boundary: <smallest change that covers the need>
Decision: code-change | no-change | needs-clarification
```

If the decision is not `code-change`, do not write the code.

## 4. Define success before editing

Convert the task into verifiable outcomes.

Examples:

```text
Fix bug
→ reproduce
→ identify first failing point
→ fix root cause
→ verify reproduction no longer fails
→ run relevant regression checks

Change shared workflow
→ identify consumers
→ modify central implementation
→ verify direct workflow behavior
→ verify affected callers
```

Verify narrow to broad:

```text
focused reproduction/test
→ affected module tests
→ relevant static checks
→ integration/build checks
→ required project gate
```

## 5. Classify failures before changing code

Every observed failure must be classified first:

```text
NEW_FAILURE
EXISTING_FAILURE
FLAKY
ENVIRONMENT
EXTERNAL_DEPENDENCY
TOOLCHAIN
EXPECTED
```

Do not treat every red check as a regression from the current change.

## 6. Anti-loop rule

One attempt means one evidence-based change followed by one relevant verification.

If the same symptom remains after two substantially similar attempts:

1. stop that approach;
2. inspect actual logs/runtime evidence;
3. revisit assumptions, dependencies, and the first failing point;
4. choose a materially different evidence-based approach.

Do not keep making speculative edits.

## 7. Completion

A task is complete when:

- requested behavior is implemented;
- relevant verification passes, or unrelated failures are classified;
- no regression caused by the change remains;
- required documentation or changelog updates are complete;
- final diff contains no temporary or out-of-scope changes.

Before claiming complete, run one fresh falsifying check against the requested behavior. Stale, partial, or verify-later evidence does not satisfy the checklist. Grade the claim:

```text
A: target + regression verified; no meaningful unknown
B: target verified; bounded residual risk stated
C: partial only; no full-completion claim
```

At B or C, state the uncovered scope explicitly. Never claim complete then verify later; downgrade the claim to match the narrowest evidence.

Then stop.

## 8. Reporting

Never claim a test, command, workflow, or behavior was verified unless it actually was.

Report:
- what changed;
- what was verified;
- any remaining risk;
- unrelated findings not applied.

## 9. Safety

Do not expose secrets. Do not weaken tests or gates merely to obtain green status. Do not rewrite shared history, publish, deploy, or perform destructive actions unless the task authorizes them.

## 10. Conflict resolution

When instructions conflict, resolve them in this order. The first level that applies wins:

```text
1. Machine contracts, policies, and rules (contracts/, policies/, rules/),
   including project-specific mandatory policies, and deterministic gates
2. Shared governance (docs/SHARED_GOVERNANCE.md, docs/ARCHITECTURE_GOVERNANCE.md)
3. Explicit requirements of the current task, where they do not conflict with levels 1-2
4. Project architecture documents and task-specific guides
5. Skills (this execution procedure)
6. Existing local implementation conventions
7. README and examples
8. Agent preference
```

Rules:

- A task instruction cannot waive a level 1 or level 2 rule.
- If the task requires a change that violates level 1 or level 2, do not make that change. Report the conflict and continue with the parts that do not conflict.
- Change a level 1 or level 2 rule only through its own governed change path.
- If placement or behavior stays materially ambiguous after context discovery, surface the ambiguity instead of guessing.

## Provenance

The Change Necessity decision token in section 3 is adapted from the `systematic-debugging` and `writing-plans` skills of `GanyuanRan/Aegis` (MIT License). The fresh-check requirement and A/B/C confidence grading in section 7 are adapted from its `verification-before-completion` skill. Their diagnostic layers, workspace artifacts, evidence-slot receipts, activation-mode gate, and method-pack governance vocabulary are not included; only the necessity gate and the falsifying-check-before-claim rule with confidence grades are absorbed as native Action Worker rules.
