# Agent Guide

This file is the agent entry point for Action Worker. Action Worker is also the authoritative repository for Fongap Labs shared governance.

## Required reading

1. `CLAUDE.md`
2. `skills/agent-execution/SKILL.md`
3. task-related `skills/*/SKILL.md`
4. `docs/README.md`
5. `docs/01_SHARED_GOVERNANCE.md`
6. `docs/ARCHITECTURE_GOVERNANCE.md`
7. `docs/03_NAMING_CONVENTIONS.md`
8. task-related `contracts/`, `policies/`, `rules/`
9. development tasks: `docs/DEVELOPMENT_GUIDE.md`
10. repository integration: `docs/05_INTEGRATION_GUIDE.md`

## Skill chain

Action Worker automatically selects skills and assembles the prompt for every task dispatch. No configuration needed.

```
Task arrives (carries agent_domain + operation labels, defaults coding + task)
      ↓
resolve-agent-skills.ts scans skills/, reads each SKILL.md frontmatter
      ↓
build-agent-prompt.ts loads CLAUDE.md + selected SKILL.md files into one prompt
      ↓
Prompt exposed via AGENT_SYSTEM_PROMPT_PATH env var
      ↓
bootstrap.sh or downstream agent reads the prompt and follows the rules
```

Each `SKILL.md` declares its scope in frontmatter (the `---` block at the top): `always`, `domain`, `baseline`, or `operations`. Adding a skill requires only creating `skills/<name>/SKILL.md` with frontmatter; no registration, no code change.

The dispatch payload may include optional `agent_domain` (default `coding`) and `operation` (default `task`). See [skills/README.md](skills/README.md) for details.

## Authority order

```text
contracts / policies / rules
        ↓
docs/01_SHARED_GOVERNANCE.md
        ↓
docs/ARCHITECTURE_GOVERNANCE.md
        ↓
docs/ARCHITECTURE.md
        ↓
task-specific guides
        ↓
skills (execution procedure)
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
- cross-repository status and publication governance;
- organization-wide Agent Skills for execution, debugging, impact analysis, review, and release verification.

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

## Commit hygiene

Every commit, in this repository and in every repository governed by Action Worker, must not carry AI agent identity or attribution. The commit must not name an AI agent, model, or vendor as its author or committer. No trailer may name an AI agent (Claude, Claude Code, Codex, Copilot or similar), for example `Co-Authored-By:`. No line may be a tool attribution such as `Generated with` or `Assisted by`. Agent names in the subject and in the body prose are allowed. The committer speaks for the change. Automated control-plane writes stay attributed to the maintainer identity, and an agent-assisted commit carries no trace of the agent.

An agent commits with the author and committer identity of the GitHub account its session is connected to: the account login and its GitHub noreply address. The repository does not fix that account. The commit attribution check in `scripts/validate-change-record.ts` fails a pull request when an author or committer names an AI agent or model, when a trailer names one, or when a title or commit line begins with a tool attribution marker. Its terms live in `policies/attribution.json`.

## Completion

A governance change is complete only when the corresponding machine contract/policy/action and regression tests match the documentation. Documentation-only intent is not an enforcement boundary.
