---
name: test-driven-development
description: Test-first implementation discipline for code changes that have a test seam. Covers test design at public seams, anti-patterns, and red-green cycles in vertical slices. Use for task operations that change observable behavior.
domain: coding
operations: [task]
---

# Test-Driven Development

Use for `task` operations that change observable behavior in code that has a test seam.

Skip for configuration-only, workflow-only, or documentation-only changes that have no test seam. For a defect, `bug-fix` owns the reproduction and the root cause. This skill owns how the regression test and any new behavior are designed and built.

## 1. Choose seams

A **seam** is the public boundary where behavior is observed without reaching inside. Tests live at seams, never against internals.

Before writing any test, decide the seams yourself:

- Prefer the highest existing seam that exercises the change.
- Add a new seam only when no existing seam can observe the behavior, and state why.
- For each seam, record what it catches and what it misses.
- If two seams would test materially different readings of the requirement, follow `agent-execution` section 2: surface the difference in the output instead of choosing silently.

## 2. Write good tests

- Verify behavior through the public interface. The interface is the test surface.
- Survive internal refactors: a refactor with no behavior change must not break the test.
- Read like a specification. Name the behavior, not the mechanism: "user can checkout with a valid cart", not "checkout calls the payment service".
- Take expected values from an independent source: a known literal, a worked example, or the spec.
- Assert one behavior per test.

## 3. Reject these anti-patterns

- **Implementation-coupled**: the test mocks internal collaborators, tests private functions, asserts internal call counts or order, or reads internal storage instead of using the interface. The signal: the test breaks on a refactor while behavior is unchanged.
- **Tautological**: the expected value recomputes the implementation, for example `expect(add(a, b)).toBe(a + b)`. Such a test passes by construction and cannot disagree with the code.
- **Horizontal slicing**: all tests are written first, then all code. The tests then describe imagined behavior, and the implementation is fixed before anything is learned. Work in vertical slices instead.

## 4. Mock only at system boundaries

Mock:
- external APIs and services;
- time and randomness;
- file system or database access when a real test instance is not practical.

Do not mock your own modules or internal collaborators.

Design boundaries for mockability:
- inject external dependencies as parameters instead of constructing them inside the function;
- prefer one function per external operation over a generic fetcher with conditional logic inside the mock.

## 5. Run the red-green loop

Repeat for each slice:

```text
one seam + one behavior
→ write one test
→ run it: it must fail for the expected reason
→ write the minimal code that makes it pass
→ run it: it must pass
→ run the affected test file
→ next slice
```

Rules:
- Red before green. A failure caused by a typo, a missing import, or a wrong fixture does not count as red.
- One slice at a time. Do not anticipate future tests or add speculative features.
- Refactoring is not part of the loop. After the behaviors in scope are green, refactor only within the change scope, as `code-minimality` requires.

## 6. Completion

The TDD work is complete when:

- every seam recorded in section 1 has the tests it needs;
- each test was observed failing before its implementation and passing after;
- the affected test files pass, and the required gate runs as `agent-execution` section 4 requires.

Report the seams, the failing output of the first slice, and any behavior left untested, with the reason.

## Provenance

The seam, test-quality, anti-pattern, and mocking rules are adapted from the `tdd` skill of `mattpocock/skills` (MIT License, Copyright (c) 2026 Matt Pocock). The interview step, the calls to other skills, and the glossary dependency are removed because the task runs unattended.
