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

Classify what you delete before deleting it:

```text
code-retirement: source code, duplicate owners, stale fallbacks → delete directly
derived-state: caches, generated indexes, temporary exports → verify they rebuild first, then delete
persistent-state: live database rows, source-of-truth files, user or audit records → never delete automatically; stop and require explicit human confirmation
```

Deleting a migration file is not deleting the database. A generic "clean it up" instruction in the task does not authorize deleting persistent state.

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

## 8. Senior engineer test

Before finishing a code change, ask:

> Would a senior engineer consider this overcomplicated?

If yes, reduce the change. Treat the answer as yes when any of these holds:

- an abstraction has a single use site and no current requirement needs it;
- a configuration option or extension point has no current caller;
- code handles a scenario that the current contract rules out, and the code is outside the hard safety boundary in section 6;
- the change is larger than the stated behavior requires.

This test never removes a safeguard listed in section 6. Input validation, error handling, security checks, and permission checks stay even when the current contract makes a case unlikely, because they protect trust boundaries that the contract may not describe.

## Provenance

The principles are derived from the upstream reference project Ponytail (`DietrichGebert/ponytail`, MIT License) and absorbed as native Action Worker rules. No Ponytail runtime, dependency, plugin, command, state file, or implementation code is included. The deletion classification in section 3 is adapted from the `anti-entropy-governance` skill of `GanyuanRan/Aegis` (MIT License); its data-destruction guard, compat-exception gate, retirement-decision contract, and workspace artifacts are not included, only the deletion classes and the code-versus-data distinction.
