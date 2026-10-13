# Agent Guide

Entry point for AI agents working on Action Worker. Action Worker is also the authoritative source of Fongap Labs shared governance.

## Required reading

1. This file.
2. `skills/agent-execution/SKILL.md` and the task-related `skills/*/SKILL.md` (see [skills/README.md](skills/README.md)).
3. `docs/SHARED_GOVERNANCE.md`, `docs/ARCHITECTURE_GOVERNANCE.md` and `docs/NAMING_CONVENTIONS.md`.
4. The task-related `contracts/`, `policies/` and `rules/`. These are the machine authority.
5. Development: `docs/DEVELOPMENT_GUIDE.md`. Repository onboarding: `docs/INTEGRATION_GUIDE.md`.

The full document map is in [docs/README.md](docs/README.md).

## Authority

On conflict, the higher item wins:

1. `contracts/`, `policies/`, `rules/`
2. `docs/SHARED_GOVERNANCE.md`
3. `docs/ARCHITECTURE_GOVERNANCE.md`, then `docs/ARCHITECTURE.md`
4. Task-specific guides
5. Skills (execution procedure)
6. READMEs

## Shared governance

- A rule that applies to two or more managed repositories is defined once, here. Never copy it into a business repository.
- Business repositories own product code, product tests, native build, package and deploy implementation, and thin dispatch entry points.

## Non-negotiable boundaries

- Never execute untrusted PR code in the control domain, which holds central secrets. See the trust domains in `docs/ARCHITECTURE_GOVERNANCE.md` section 6.
- Never add repository-name or project-name branches. Never add `projects/`, `adapters/` or `profiles/` directories for business-repository differences.
- Callers never supply gate conclusions, base or head SHAs, models or runner names. Action Worker reads these from GitHub and decides them itself.
- AI review is advisory. It must not change `validate-merge`, `PR Governance`, `CI Evidence` or the Main Write Guard.
- Provider and model fallback belong to AI Gateway. Action Worker only selects a logical model.
- Never weaken a test, gate or check to obtain a green status.

## Commit hygiene

Commit messages in this repository, and in every repository governed by Action Worker, must not contain AI agent identity or attribution. Do not add `Co-Authored-By:` trailers that name an AI agent, `Generated with` or `Assisted by` lines, or agent, model or vendor names. The committer speaks for the change.

## Completion

A governance change is complete only when the matching machine contract, policy or action and its regression tests agree with the documentation. Documentation alone is not an enforcement boundary.
