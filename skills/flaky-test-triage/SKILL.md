---
name: flaky-test-triage
description: Identify, reproduce, classify, and remediate non-deterministic test failures before modifying source code.
domain: coding
operations: [ci, task]
---

# Flaky Test Triage

Use when a test fails intermittently: passes on some runs, fails on others, with no corresponding code change.

`ci-diagnose` classifies a failure as `FLAKY`; this skill owns the investigation and remediation procedure that follows.

## 1. Confirm non-determinism

Before treating a failure as flaky, prove it:

- run the suspect test in isolation, repeated 50 to 100 times;
- record the pass/fail ratio;
- if it fails deterministically, it is not flaky — follow `bug-fix`;
- if it passes most of the time but fails occasionally, proceed.

A single green run after a red run does not prove flakiness. A single red run after green runs does not prove a regression.

## 2. Classify the non-deterministic root cause

Check each category before modifying code:

```text
ASYNC_RACE        — missing await, unresolved promise, callback ordering
TIME_CLOCK        — system time, timezone, daylight saving, mock-clock gap
SHARED_STATE      — static variables, module-level cache, test pollution across cases
RANDOM_SEED       — unseeded RNG, float precision drift
FILESYSTEM_STATE  — leftover temp files, working directory assumption, path collision
NETWORK_EXTERNAL  — real network calls, DNS timing, third-party service availability
RESOURCE_EXHAUSTION — memory, file handles, connection pool, thread limit
ORDER_DEPENDENCY   — tests that pass in one order but fail in another
```

Record the category with evidence. Do not guess.

## 3. Reproduce under stress

- run the test with widened timing windows (add delays, parallelism, or load);
- pin and vary the random seed;
- run in a clean filesystem state and in a polluted one;
- run in reversed test order;
- increase parallelism to surface races.

The goal is a reproduction rate high enough to debug, not necessarily 100%.

## 4. Isolate without blocking

If the root cause cannot be located quickly:

- quarantine the test (skip, annotate with `@quarantine` or the project's equivalent);
- create a tracking issue with the pass/fail ratio, suspected category, and reproduction steps;
- do not silently delete the test or remove the assertion;
- do not weaken the assertion to make it pass.

Quarantine is a temporary measure. The tracking issue owns the resolution.

## 5. Fix the root cause

Once the root cause is identified:

- fix the owning site, not the symptom (follow `bug-fix` section 3);
- seed randomness at the test boundary;
- isolate shared state with proper setup and teardown;
- replace real network calls with mocks at system boundaries;
- remove order dependencies by making each test independent.

Do not add `retry` logic to a flaky test. Retrying hides the root cause and does not fix it.

## 6. Verify the fix

- run the previously flaky test 100 times in isolation — all green;
- run it in reversed order and under stress — all green;
- run the full affected test file — all green;
- remove the quarantine annotation;
- close the tracking issue.

## 7. Completion

The flaky test is resolved when:

- root cause is identified and classified;
- fix targets the owning site, not the symptom;
- the test passes 100 consecutive runs under stress;
- quarantine is removed;
- no assertion was weakened or deleted.
