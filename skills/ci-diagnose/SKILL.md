---
name: ci-diagnose
description: Diagnose CI failures from evidence before modifying source, workflow, permissions, or infrastructure.
domain: coding
operations: [ci]
---

# CI Diagnose

Use whenever a workflow, job, required check, or PR gate is red.

## Principle

A red CI result is a symptom, not a diagnosis. Do not change code until the failing layer is identified.

## Workflow

### 1. Identify the first failing job and step

Collect the workflow, run and event, head SHA, job, first failing step, exit code or API status,
and relevant log lines. Ignore downstream cancellations and secondary failures until the first
failure is understood.

Read the failed job log when the diagnostic token has `actions: read`. The summary must not print
raw log contents or secret values. If the log is missing or unreadable, keep the cause unknown;
job and step names alone are not evidence that a retry is safe.

### 2. Classify the failure and its cause

Use one failure class:

```text
transient_network
api_rate_limit
upstream_service
runner
dependency
configuration
permission
credential_missing
source_test
security_gate
stale_task
unknown
```

Also classify causality as `NEW_FAILURE`, `EXISTING_FAILURE`, `ENVIRONMENT`,
`EXTERNAL_DEPENDENCY`, or `FLAKY`. Prefer error text from the failed job log over workflow or step
names. Keep unknown causes unknown.

### 3. Check change relevance

Compare the failed path with the diff. If the failure is unrelated to the changed area, do not modify
unrelated source merely to make the check green.

### 4. Diagnose by evidence

- `source_test`: reproduce locally or in the narrowest test; do not retry unchanged source.
- `configuration`: validate syntax, event context, inputs, expressions, and called workflow contracts.
- `permission` / `credential_missing`: verify the required scope, name, and Environment without
  printing secret values.
- `transient_network` / `api_rate_limit` / `upstream_service` / `runner`: require matching log
  evidence before considering recovery.
- `dependency`: inspect the exact package and lockfile error; only retry when the log proves a
  transient fetch or service interruption.
- `security_gate`: inspect the policy and evidence that rejected the change; never retry to bypass
  the gate.
- `stale_task`: skip the obsolete task and evaluate the current source SHA before dispatching work.
- `unknown`: stop and inspect the log; do not guess a fix or retry policy.

### 5. Fix only the owning layer

Do not compensate for a permission problem by changing application code. Do not compensate for a
flaky dependency by weakening tests. Do not bypass required checks or security controls to obtain a
green status.

### 6. Verify

Re-run or re-evaluate the narrow failed layer first, then the required project gate. Record
unresolved external or platform failures separately.

## Recovery boundary

Only a proven temporary network failure, API rate limit, upstream 5xx response, or lost runner may
receive an automatic retry, and only when the operation is idempotent. Use a finite attempt budget,
exponential backoff with jitter, and any valid server-provided `Retry-After` or reset time. If the
server delay exceeds the remaining job budget, stop without retrying early. Never retry unchanged
permission, credential, configuration, source/test, dependency, security, stale-task, or unknown
failures. A successful non-idempotent operation must not be dispatched again.
