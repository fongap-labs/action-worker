---
name: bug-fix
description: Root-cause-driven bug repair that prevents speculative fix loops and requires regression protection.
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

## Workflow

### 1. Reproduce

Find the smallest reliable reproduction:
- failing test;
- exact command;
- minimal input;
- workflow/job/step;
- deterministic log signature.

If direct reproduction is impossible, collect the strongest available runtime evidence and state the limitation.

### 2. Locate the first failing point

Trace:

```text
symptom
→ first incorrect state
→ producer of that state
→ violated contract
→ root cause
```

Do not patch the final error message when the invalid state was created earlier.

### 3. Classify

Classify related failures as:

```text
NEW_FAILURE
EXISTING_FAILURE
FLAKY
ENVIRONMENT
EXTERNAL_DEPENDENCY
TOOLCHAIN
EXPECTED
```

### 4. Analyze blast radius

Identify:
- callers;
- consumers;
- shared contracts;
- tests;
- workflows;
- cross-repository dependencies.

Load `change-impact` when the fix changes a shared interface or central workflow.

### 5. Apply the minimal patch

Change the smallest responsibility boundary that owns the root cause.

Do not combine the fix with unrelated refactoring, dependency upgrades, formatting, or naming cleanup.

### 6. Add regression protection

Prefer:

```text
reproduction fails before fix
→ patch
→ same reproduction passes
→ regression test remains
```

If an automated test is not feasible, add the strongest deterministic verification available and record why.

### 7. Verify narrow to broad

```text
reproduction
→ affected tests
→ static checks
→ integration/build
→ required CI/gate
```

### 8. Stop condition

Stop when:

```text
root cause fixed
+ regression protection exists
+ affected verification passes
+ no new related failures remain
= DONE
```

Unrelated failures become separate findings. Do not expand the current patch indefinitely.
