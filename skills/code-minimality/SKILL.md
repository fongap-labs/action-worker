---
name: code-minimality
description: Prefer reuse, minimal change sets, deletion, and root-cause fixes while writing or changing code. Apply to every code-changing task.
domain: coding
baseline: true
---

# Code Minimality

Apply to every task that adds or changes code.

The goal is the minimal necessary implementation, not the least code. Never trade correctness, security, maintainability, accessibility, or existing constraints for fewer lines.

## 1. Reuse before writing

Understand the problem first, then stop at the first step that satisfies the task:

```text
existing code, helper, module, or tool
→ standard library
→ platform-native capability
→ already-installed dependency
→ new code
→ new dependency
```

Check the existing implementation before adding any new one. Add code only when existing capability cannot satisfy the requirement. A new dependency needs a concrete benefit that no earlier step provides.

## 2. Minimal change set

Default to:

```text
fewest files
least new code
fewest new abstractions
fewest new dependencies
smallest impact radius
```

Do not add wrapper, adapter, factory, registry, manager, service, abstraction layer, or configuration layer for "architectural completeness" unless the current requirement or existing architecture explicitly needs it.

## 3. Prefer deletion

When removing unused code solves the problem, delete it instead of adding a compatibility layer.

## 4. Fix the root cause

Locate the first failing point and repair the root cause, keeping the necessary verification. Do not stack a workaround on the symptom, then a special case, then another fallback.

## 5. No speculative extension

Do not incidentally:

- refactor related modules;
- add new abstractions;
- modify unrelated APIs;
- unify unrelated code style;
- upgrade dependencies;
- change other business logic.

A potential future need is not a current requirement. Make such changes only when the task cannot be completed without them.

## 6. Hard safety boundary

Minimality never justifies removing or weakening:

```text
security
input validation
error handling
permission checks
access control
data-loss prevention
auditability
accessibility
release safety
deterministic gates
```

"Fewer lines" is never a reason to cut input validation, permission checks, exception handling, security checks, or audit records.

## 7. Governance position

This skill is advisory for agent execution and AI review. It must not bypass or lower CI, security, release, permission, or repository-protection gates, and it never auto-approves a change. Deterministic gates remain the only merge authority.

## Provenance

The principles are derived from the upstream reference project Ponytail (`DietrichGebert/ponytail`, MIT License) and absorbed as native Action Worker rules. No Ponytail runtime, dependency, plugin, command, state file, or implementation code is included.
