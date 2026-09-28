# Agent Skills

This directory holds the rule books that AI agents read before doing any work. Think of it as an onboarding manual: the agent reads the relevant skills first, then starts the task.

## What is a skill?

Each subdirectory contains a `SKILL.md` file — a set of rules telling the AI agent how to approach a task: investigate before coding, verify after changes, don't loop on the same failed approach. It is like giving a new hire a checklist before they touch production.

## Skills

| Skill | Purpose |
|---|---|
| [agent-execution](agent-execution/SKILL.md) | Baseline rules for every task: investigate first, verify after changes, avoid loops |
| [code-minimality](code-minimality/SKILL.md) | When changing code: reuse over rewrite, delete over add, fix root cause not symptoms |
| [bug-fix](bug-fix/SKILL.md) | For bug fixes: find root cause first, then add regression protection |
| [ci-diagnose](ci-diagnose/SKILL.md) | When CI is red: diagnose before touching code |
| [change-impact](change-impact/SKILL.md) | Before changing shared code: figure out the blast radius |
| [pr-review](pr-review/SKILL.md) | Checklist for reviewing pull requests |
| [release-verify](release-verify/SKILL.md) | Before/after release: verify source, artifacts, checksums, rollback |
| [writing](writing/SKILL.md) | For content tasks: no fabrication, verify facts, surgical edits |

## How to use

You do not need to configure anything. When a task is dispatched, the system automatically picks the right skills, assembles them into a prompt, and hands it to the agent.

Examples:

```
# Scenario 1: normal coding task (most common)
# Do not fill anything. The system defaults to the "coding" domain.
# Auto-loads: agent-execution + code-minimality + bug-fix

# Scenario 2: writing task (docs, copy, briefs)
# Add one field to the dispatch payload:
agent_domain: "writing"
# Auto-loads: agent-execution + writing
# Does NOT load code-minimality (no code changes needed)

# Scenario 3: CI diagnosis task
# Specify the operation:
agent_domain: "coding"
operation: "ci"
# Auto-loads: agent-execution + code-minimality + ci-diagnose
```

## How the system picks skills

Four steps, fully automatic:

```
Step 1: Task arrives
         The task carries two labels: domain (coding or writing) and operation (task, ci, review, ...)
         If not specified, defaults to coding + task

Step 2: Scan skills/ directory
         The system reads the frontmatter (the lines between --- at the top of each SKILL.md)
         Based on the declaration, it decides whether to include that skill

Step 3: Assemble prompt
         The selected SKILL.md files + CLAUDE.md are concatenated into one system prompt
         The prompt is written to a file and exposed via the AGENT_SYSTEM_PROMPT_PATH env var

Step 4: Agent runs
         bootstrap.sh or the downstream agent reads the prompt and follows the rules
```

## How to add a new skill

Create a folder, drop in a `SKILL.md`, done. No registration, no code change, no config file.

```
skills/
  my-new-skill/          ← create folder
    SKILL.md              ← write rules
```

Write a few lines of declaration (frontmatter) at the top of `SKILL.md` to tell the system when to load it:

```yaml
---
name: my-new-skill                    # skill name
description: One-line purpose          # required
always: true                          # load for every task (optional)
# OR use the domain-based approach:
domain: coding                        # which domain (coding, writing, ...)
baseline: true                        # load for every operation in this domain (optional)
operations: [task, ci]                # load only for specific operations (optional)
---

# My New Skill

Write the rules here...
```

Pick one loading mode:

| Declaration | Meaning | Example |
|---|---|---|
| `always: true` | Loaded for every domain and operation | `agent-execution` |
| `domain: xxx, baseline: true` | Loaded for every operation in that domain | `code-minimality` (coding baseline) |
| `domain: xxx, operations: [...]` | Loaded only for matching operations | `bug-fix` (only coding+task) |

## Constraint

A skill must not weaken deterministic gates or override project-specific mandatory policy.

## Code minimality

[code-minimality](code-minimality/SKILL.md) turns code-minimality principles into native Action Worker guidance for both execution and review.

- Scope: advisory discipline for any task or review that adds or changes code. It is not a separate execution engine and adds no runtime, dependency, or extra model call.
- Agent execution: applied through this standard skill chain; agents receive it as text rules like every other skill.
- AI Review: the minimality guidance is merged into the single existing rule entry in `rules/code.json` (code, refactor, and implementation reviews) and `rules/architecture.json` (architecture reviews), so it rides the existing single AI Review call. OpenCodeReview applies only the first matching rule per path pattern, so each review rule file keeps exactly one `**/*` entry. Review output stays in the existing format.
- Safety boundary: it never justifies removing or weakening security, input validation, error handling, permission checks, access control, data-loss prevention, auditability, accessibility, release safety, or deterministic gates, and it never bypasses CI, auto-approves a PR, or lowers test requirements.
- Deterministic gates: unchanged. AI Review stays advisory; CI / PR / deterministic policy remains the merge authority.

Provenance: the principles are derived from the upstream reference project Ponytail (`DietrichGebert/ponytail`, MIT License) and absorbed as native Action Worker rules; no Ponytail runtime, dependency, plugin, command, or implementation code is included.