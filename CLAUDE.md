# Agent Guide

本文件是 Action Worker 的 Agent 入口。Action Worker 同时是 Fongap Labs 共用治理的权威仓库。

## Required reading

1. `CLAUDE.md`
2. `docs/README.md`
3. `docs/SHARED_GOVERNANCE.md`
4. `docs/ARCHITECTURE_GOVERNANCE.md`
5. `docs/NAMING_CONVENTIONS.md`
6. task-related `contracts/`, `policies/`, `rules/`
7. development tasks: `docs/DEVELOPMENT_GUIDE.md`
8. repository integration: `docs/INTEGRATION_GUIDE.md`

## Authority order

```text
contracts / policies / rules
        ↓
docs/SHARED_GOVERNANCE.md
        ↓
docs/ARCHITECTURE_GOVERNANCE.md
        ↓
docs/ARCHITECTURE.md
        ↓
task-specific guides
        ↓
README
```

## Shared governance rule

If a rule applies to two or more managed repositories, prefer defining it once in Action Worker. Business repositories retain only product-specific architecture, contracts, dependencies, release compatibility and other project-local boundaries.

Do not create copies of shared naming, changelog, PR Gate, Release Governance or Repository Policy in business repositories.

## Control-plane boundary

Action Worker owns generic:

- Task Dispatch;
- PR Governance;
- AI Triage / Review;
- CI Evidence evaluation;
- merge Gate;
- Source / Release / Deploy policy;
- cross-repository status and publication governance.

Business repositories own product code, product tests, native build/package/deploy implementation and thin dispatch/integration entry points.

## Trust boundary

```text
Control
├─ GitHub metadata / diff
├─ Plan
├─ AI Triage / Review
├─ CI Evidence evaluation
├─ Gate
└─ central secrets allowed

Sandbox
├─ checkout untrusted change
├─ build / test / verify
└─ central secrets forbidden
```

Never execute untrusted PR code in the central-secret control domain.

## Architecture guardrails

Do not add repository-name branches or project-specific policy layers inside Action Worker. Do not add `projects/`, `adapters/` or `profiles/` for business-repository differences.

Provider/model fallback belongs to AI Gateway. Action Worker may route logical review depth but must not recreate upstream provider failover.

## Completion

A governance change is complete only when the corresponding machine contract/policy/action and regression tests match the documentation. Documentation-only intent is not an enforcement boundary.
