---
name: bug-fix
description: Root-cause-driven bug repair that prevents speculative fix loops and requires regression protection.
domain: coding
operations: [task]
---

# Bug Fix

Use for defects, regressions, runtime failures, broken tests, or repeated repair loops.

## Hard rules

```text
No reproduction, no fix.
No root cause, no patch.
No regression protection, bug is not closed.
```

Do not fix a newly observed failure until there is evidence that it was introduced by the current change or is required for the requested behavior.

## Redact first

Commands, outputs, and captured artifacts can contain secrets and auth headers.

- Replace every secret with `<REDACTED>` before it appears in a log, a report, or a PR text.
- Build loops against environment variables, so the credential stays in the environment and never in what you show.
- Quote only the lines that carry the signal from a captured artifact.

If the redacted output is not enough to diagnose the failure, say so in the report and stop at the evidence you have.

## Workflow

### 1. Build a feedback loop

The feedback loop is the core of the fix. Everything after it is mechanical.

Find one command that goes red on this bug and run it once, showing its redacted output. Ways to build one, roughly in order:

1. failing test at the seam that reaches the bug;
2. HTTP or CLI invocation with a fixture input, diffed against a known-good snapshot;
3. headless browser script that asserts on DOM, console, or network;
4. replay of a captured trace or payload through the code path in isolation;
5. throwaway harness with a minimal subset of the system;
6. property or fuzz loop for "sometimes wrong output";
7. bisection harness for a regression between two known states (`git bisect run`);
8. differential loop: old version against new version, or two configurations.

The loop must be:

- **Red-capable**: it asserts the user's exact symptom, not merely "no crash".
- **Deterministic**: the same verdict on every run.
- **Fast**: seconds, not minutes.
- **Agent-runnable**: it runs unattended.

Tighten a working loop: make it faster, assert on the specific symptom, pin time, seed randomness, isolate the file system, and freeze the network.

For a non-deterministic bug, the goal is a higher reproduction rate, not a clean repro. Loop the trigger, parallelise, add stress, and widen timing windows until the bug is debuggable.

If no loop can be built, stop. Report what was tried and which evidence would enable a loop: access to the environment, a captured artifact, or permission to add instrumentation. Do not hypothesise without a loop.

### 2. Reproduce and minimise

Run the loop until it goes red. Confirm that it produces the failure the requester described, not a nearby failure. Capture the exact symptom, so the fix can be verified against it.

Then shrink the scenario. Cut inputs, callers, configuration, data, and steps one at a time, and rerun the loop after each cut. Keep only what is load-bearing: removing any remaining element must turn the loop green.

Do not proceed until the scenario is both reproduced and minimised.

### 3. Locate the first failing point

Trace:

```text
symptom
→ first incorrect state
→ producer of that state
→ violated contract
→ root cause
```

Do not patch the final error message when the invalid state was created earlier.

Before testing any cause, write 3 to 5 ranked hypotheses. Each hypothesis must be falsifiable:

```text
If <X> is the cause, then <changing Y> makes the symptom disappear.
```

A hypothesis without a predicted result is discarded. Test the hypotheses in rank order, and change one variable per probe.

For a performance regression, establish a baseline measurement (timing harness, profiler, or query plan) before any bisection. Measure first, fix second.

### 4. Classify

Classify each related failure with the classes defined in `agent-execution` section 5 before changing code.

### 5. Analyze blast radius

Identify:
- callers;
- consumers;
- shared contracts;
- tests;
- workflows;
- cross-repository dependencies.

Load `change-impact` when the fix changes a shared interface or central workflow.

### 6. Apply the minimal patch

Change the smallest responsibility boundary that owns the root cause.

Do not combine the fix with unrelated refactoring, dependency upgrades, formatting, or naming cleanup.

### 7. Add regression protection

Prefer:

```text
reproduction fails before fix
→ patch
→ same reproduction passes
→ regression test remains
```

Write the regression test at a seam that exercises the real bug pattern as it occurs at the call site. Load `test-driven-development` for the test design. If the only available seam is too shallow to reproduce the bug, record that as a finding: the architecture prevents the bug from being locked down. Do not add a test that gives false confidence.

If an automated test is not feasible, add the strongest deterministic verification available and record why.

### 8. Instrument with discipline

Use this step only when the loop needs probes.

- Prefer a debugger or REPL inspection. Otherwise add targeted logs at the boundaries that separate the hypotheses. Never "log everything and grep".
- Tag every temporary debug log with a unique prefix, such as `[DEBUG-a4f2]`.
- Before finishing, search for the prefix and remove every tagged line.

### 9. Verify narrow to broad

```text
reproduction
→ affected tests
→ static checks
→ integration/build
→ required CI/gate
```

### 10. Stop condition

Stop when:

```text
root cause fixed
+ regression protection exists
+ affected verification passes
+ no temporary debug instrumentation remains
+ no new related failures remain
= DONE
```

Unrelated failures become separate findings. Do not expand the current patch indefinitely.

## Provenance

The feedback-loop, minimisation, falsifiable-hypothesis, instrumentation, and redaction rules are adapted from the `diagnosing-bugs` skill of `mattpocock/skills` (MIT License, Copyright (c) 2026 Matt Pocock). Steps that waited for a human answer were changed to report and stop, because the task runs unattended.
