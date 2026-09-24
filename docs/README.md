# Documentation

[**English**](README.md) · [简体中文](README.zh-CN.md)

Action Worker keeps three categories of documentation:

1. shared governance for Fongap Labs managed repositories;
2. Action Worker control-plane architecture and implementation;
3. reusable Agent Skills for engineering execution.

Managed repositories keep only project-specific rules and do not duplicate shared governance from this repository.

## Shared governance

| Document | Purpose |
|---|---|
| [SHARED_GOVERNANCE.md](SHARED_GOVERNANCE.md) | Shared governance boundaries and authority relationships across Fongap Labs |
| [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) | Shared naming rules plus Action Worker-specific constraints |
| [CHANGELOG_CONVENTIONS.md](CHANGELOG_CONVENTIONS.md) | Unified change classification for PRs, CHANGELOG entries, and releases |
| [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) | Common development, validation, PR, and merge rules |
| [REPOSITORY_GOVERNANCE.md](REPOSITORY_GOVERNANCE.md) | Repository settings, merge strategy, and GitHub platform boundaries |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | Standard contract for onboarding managed repositories to central governance |

## Agent Skills

The source of truth for reusable agent execution behavior is [`skills/`](../skills/README.md). Skills define execution procedure and must not override machine contracts, policies, or rules.

## Action Worker specific

| Document | Purpose |
|---|---|
| [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md) | Long-term control-plane architecture boundaries |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current implementation and runtime model |

## Machine authority

Documentation explains why and how. Machine authority remains in:

```text
contracts/   input/output contracts
policies/    deterministic governance policy
rules/       AI Review rules
tests/       contract and governance regression tests
```

Agent Skills are reusable execution procedures, not deterministic policy authority. Documentation and skills must not override or bypass machine contracts.

## Shortest entry

```text
Develop Action Worker
→ CLAUDE.md
→ skills/agent-execution/SKILL.md
→ task-related skill
→ docs/SHARED_GOVERNANCE.md
→ docs/ARCHITECTURE_GOVERNANCE.md
→ related contracts / policies / rules

Work in a managed repository
→ repository CLAUDE.md
→ docs/SHARED_GOVERNANCE.md
→ project-specific architecture / boundary docs

Change shared governance
→ docs/SHARED_GOVERNANCE.md
→ related contracts / policies / rules
→ governance regression tests
```

Chinese overview: [README.zh-CN.md](README.zh-CN.md)
