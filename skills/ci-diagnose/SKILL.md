---
name: ci-diagnose
description: Diagnose CI failures from evidence before modifying source, workflow, permissions, or infrastructure.
---

# CI Diagnose

Use whenever a workflow, job, required check, or PR gate is red.

## Principle

A red CI result is a symptom, not a diagnosis.

Do not change code until the failing layer is identified.

## Workflow

### 1. Identify the first failing job and step

Collect:
- workflow name;
- run/event;
- head SHA;
- job;
- first failing step;
- exit code or API status;
- relevant log lines.

Ignore downstream cancellations and secondary failures until the first failure is understood.

### 2. Classify the failure layer

```text
SOURCE
TEST
WORKFLOW
CONFIG
PERMISSION
SECRET
QUOTA
RUNNER
NETWORK
UPSTREAM_SERVICE
DEPENDENCY
FLAKY
GOVERNANCE
```

Also classify causality:

```text
NEW_FAILURE / EXISTING_FAILURE / ENVIRONMENT / EXTERNAL_DEPENDENCY / FLAKY
```

### 3. Check change relevance

Compare the failed path with the diff.

If the failure is unrelated to the changed area, do not modify unrelated source merely to make the check green.

### 4. Diagnose by layer

- SOURCE / TEST: reproduce locally or in the narrowest test.
- WORKFLOW / CONFIG: validate syntax, event context, inputs, expressions, and called workflow contracts.
- PERMISSION / SECRET: verify required scope/name/exposure boundary without printing secret values.
- QUOTA / RUNNER / NETWORK: confirm platform/runtime evidence before touching source.
- UPSTREAM_SERVICE / DEPENDENCY: verify external status/version and distinguish transient from deterministic failure.
- GOVERNANCE: inspect the policy/gate that rejected the change and the evidence it consumed.

### 5. Fix only the owning layer

Do not compensate for a permission problem by changing application code.
Do not compensate for a flaky dependency by weakening tests.
Do not bypass AI Review, Gate, required checks, or security controls to obtain green status.

### 6. Verify

Re-run or re-evaluate the narrow failed layer first, then the required project gate.

Record unresolved external or platform failures separately.
