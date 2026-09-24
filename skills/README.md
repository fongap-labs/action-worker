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
| [bug-fix](bug-fix/SKILL.md) | Root-cause-driven bug repair with regression protection |
| [ci-diagnose](ci-diagnose/SKILL.md) | Classify and diagnose CI failures before modifying code |
| [change-impact](change-impact/SKILL.md) | Determine blast radius across modules, workflows, and repositories |
| [pr-review](pr-review/SKILL.md) | Review diffs for correctness, scope, regression, security, and governance |
| [release-verify](release-verify/SKILL.md) | Verify release source, artifacts, checksums, metadata, and publication |

## Usage

Always apply `agent-execution`. Load the narrow task skill only when relevant.

```text
agent-execution
      ↓
task-specific skill
      ↓
project-specific instructions
      ↓
contracts / policies / rules
```

A skill must not weaken deterministic gates or override project-specific mandatory policy.
