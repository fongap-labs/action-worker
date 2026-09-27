# Agent Skills

This directory is the source of truth for reusable Fongap Labs agent execution skills.

## Boundary

- `skills/` owns organization-wide agent behavior, debugging, review, impact analysis, and verification workflows.
- `docs/` explains governance architecture and human-facing policy.
- `rules/`, `policies/`, and `contracts/` remain the machine authority for deterministic governance.
- Product repositories keep only product-specific instructions.
- `external-vault` may distribute reusable assets, but it is not the authority for organization-wide agent behavior.

## Skills

| Skill | Purpose |
|---|---|
| [agent-execution](agent-execution/SKILL.md) | Baseline reasoning, scope, verification, anti-loop, and completion behavior |
| [code-minimality](code-minimality/SKILL.md) | Reuse-first ladder, minimal change sets, deletion over extension, and root-cause fixes without weakening safety or gates |
| [bug-fix](bug-fix/SKILL.md) | Root-cause-driven bug repair with regression protection |
| [ci-diagnose](ci-diagnose/SKILL.md) | Classify and diagnose CI failures before modifying code |
| [change-impact](change-impact/SKILL.md) | Determine blast radius across modules, workflows, and repositories |
| [pr-review](pr-review/SKILL.md) | Review diffs for correctness, scope, regression, security, and governance |
| [release-verify](release-verify/SKILL.md) | Verify release source, artifacts, checksums, metadata, and publication |

## Usage

Always apply `agent-execution`. Apply `code-minimality` to every task that adds or changes code. Load the narrow task skill only when relevant.

```text
agent-execution
      ↓
code-minimality (code-changing tasks)
      ↓
task-specific skill
      ↓
project-specific instructions
      ↓
contracts / policies / rules
```

A skill must not weaken deterministic gates or override project-specific mandatory policy.

## Code minimality

[code-minimality](code-minimality/SKILL.md) turns code-minimality principles into native Action Worker guidance for both execution and review.

- Scope: advisory discipline for any task or review that adds or changes code. It is not a separate execution engine and adds no runtime, dependency, or extra model call.
- Agent execution: applied through this standard skill chain; agents receive it as text rules like every other skill.
- AI Review: the minimality guidance is merged into the single existing rule entry in `rules/code.json` (code, refactor, and implementation reviews) and `rules/architecture.json` (architecture reviews), so it rides the existing single AI Review call. OpenCodeReview applies only the first matching rule per path pattern, so each review rule file keeps exactly one `**/*` entry. Review output stays in the existing format.
- Safety boundary: it never justifies removing or weakening security, input validation, error handling, permission checks, access control, data-loss prevention, auditability, accessibility, release safety, or deterministic gates, and it never bypasses CI, auto-approves a PR, or lowers test requirements.
- Deterministic gates: unchanged. AI Review stays advisory; CI / PR / deterministic policy remains the merge authority.

Provenance: the principles are derived from the upstream reference project Ponytail (`DietrichGebert/ponytail`, MIT License) and absorbed as native Action Worker rules; no Ponytail runtime, dependency, plugin, command, or implementation code is included.
