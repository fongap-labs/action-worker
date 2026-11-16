# Agent Guide

Action Worker is Fongap Labs' shared GitHub control plane. Machine-enforced behavior lives in `contracts/`, `policies/`, `rules/`, and CI validators; this guide must not duplicate or override those sources.

## Required reading

1. `skills/agent-execution/SKILL.md` and task-related `skills/*/SKILL.md`.
2. `docs/README.md`, `docs/01_SHARED_GOVERNANCE.md`, and `docs/ARCHITECTURE_GOVERNANCE.md`.
3. Relevant contracts, policies, rules, tests, and task-specific documentation.

Skills are selected by `scripts/resolve-agent-skills.ts` and assembled by `scripts/build-agent-prompt.ts`. The final prompt path is supplied by `AGENT_SYSTEM_PROMPT_PATH`. Execution skills guide procedures, not policy authority.

## Boundaries

- Define governance shared by multiple managed repositories once in Action Worker. Keep product-specific implementation and tests in the owning repository.
- The control domain handles credentials, metadata, planning, evidence, and decisions. Run untrusted changes only in the sandbox, without central secrets.
- Deterministic, current-head, verified CI and merge checks govern admission. AI review is advisory; a completed review does not grant merge permission.
- Do not introduce repository-name branches or project-specific `projects/`, `adapters/`, or `profiles/` layers in this control plane.
- Provider/model fallback is owned by AI Gateway, not by Action Worker.

## Changes

- Use `feat`, `fix`, or `chore` PR titles with English ASCII summaries and follow `policies/naming.json`. Record changes in Chinese under `## [Unreleased]` in `CHANGELOG.md`; the dedicated release promotion flow is a separate case.
- Attribute commits to the connected GitHub account, not to an agent, model, or vendor. Do not add tool-generated attribution, AI identities, or `Co-Authored-By` agent trailers. The enforced terms are in `policies/attribution.json`.
- Change the corresponding machine contract, implementation, and regression tests together when governance changes. Documentation alone is not an enforcement boundary.
- Before merge, run `npm run check` and require the repository's CI gate to pass. Do not bypass CI or require a separate human review gate for a single-maintainer repository.
