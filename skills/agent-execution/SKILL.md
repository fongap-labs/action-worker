---
name: agent-execution
description: Baseline execution discipline for coding and repository agents. Use for every engineering task.
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
