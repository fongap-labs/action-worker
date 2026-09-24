---
name: pr-review
description: Review a pull request for correctness, scope, regression risk, security, architecture, workflow, and release impact.
---

# PR Review

Use for human or AI pull-request review.

## Review order

### 1. Intent and contract

Determine:
- requested behavior;
- changed files;
- declared change type;
- affected contracts;
- required verification.

### 2. Scope

Flag:
- unrelated refactors;
- duplicated shared logic;
- speculative compatibility;
- unnecessary dependency changes;
- generated/debug artifacts.

### 3. Correctness

Inspect data flow and failure paths, not only syntax.

Ask:
- Does the change modify the owning responsibility?
- Are invalid states prevented at their source?
- Are edge cases implied by the contract covered?
- Is fallback behavior deterministic?

### 4. Regression protection

For bug fixes, require a reproduction/regression guard.
For shared behavior, require affected consumer evidence.
For workflow/governance changes, require deterministic checks where possible.

### 5. Security and trust boundaries

Check:
- secret exposure;
- permission expansion;
- untrusted code execution;
- path/network validation;
- authentication/authorization;
- artifact integrity;
- bypasses of required gates.

### 6. Architecture

Reject duplicated authority, hidden coupling, repository-name branching, and new abstraction layers without demonstrated need.

### 7. Failure classification

A failing check blocks only according to the repository's real policy. Diagnose whether it is caused by the PR before requesting unrelated code changes.

## Review output

Prioritize findings by severity and provide:
- concrete file/behavior;
- failure mechanism;
- impact;
- minimal correction;
- verification needed.

Do not invent findings to fill categories.
