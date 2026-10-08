# Architecture Governance

Action Worker is the GitHub automation governance and execution plane of Fongap Labs. This document defines the long-term boundaries. The implementation may migrate in stages, but no implementation that runs against these boundaries may grow further.

The unified execution contract is in [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md), and the runner and self-hosted boundary is in [RUNNER_POLICY.md](RUNNER_POLICY.md).

## 1. Core boundary

```text
Action Worker
= shared governance
+ execution authority
+ generic executors
+ runner resolution
+ AI Agent runtime
+ gate
+ provenance

Business repository
= source
+ tests
+ project scripts
+ project architecture
+ execution manifest
+ migration-only thin event bridge

Execution Ingress
= trusted repository event intake
+ Execution Request creation

Runner
= disposable compute backend
```

Public and private repositories use the same execution architecture.

The long-term entry point must be central as well: a GitHub App, a webhook or another trusted execution ingress turns repository events directly into Action Worker execution requests. The thin dispatch in a business repository is only a migration compatibility layer; whether a business repository has Actions minutes left must never be a dependency of central execution.

Apart from the thinnest dispatch during migration, all execution — CI, test, build, AI Review, the merge gate, release, deploy, tasks and scheduled jobs — goes into Action Worker. Local check or status bridges in business repositories are also migration paths to be removed.

A business repository owns the project implementation, but not central governance, central secrets, runner policy or the final execution authority.

## 2. Small kernel, large framework

The Action Worker kernel keeps only the stable authority:

```text
Validate
→ Inspect
→ Plan
→ Authorize
→ Grant
→ Resolve Runner
→ Execute
→ Evidence / Provenance
→ Gate
```

The large framework is provided by generic executors:

```text
CI
Build
Review
Task
Release
Deploy
Scheduled Job
Artifact
```

Adding an ordinary repository, project or runner backend must not require a kernel change.

### 2.1 Converging languages and runtimes

"Small kernel, large framework" is an architecture goal; a language is not. No repository or module may make "rewrite everything in Rust", "everything in TypeScript" or any other single-language move a refactoring goal of its own.

The choice of language follows module boundaries, performance, security, maintainability, ecosystem maturity and development efficiency. An existing implementation with a clear, stable and cheap language boundary must not be rewritten only to unify the language.

At the same time, more languages are not better. Unneeded languages and runtimes should be removed first when all of these hold:

- performance does not drop;
- the security boundary does not weaken;
- functionality and compatibility do not drop;
- maintainability does not drop;
- no heavier runtime, build chain or deployment burden is introduced.

One responsibility has exactly one authority, and one capability has exactly one execution contract. When two languages maintain duplicate implementations, duplicate state or duplicate protocols for the same responsibility, removing the overlap comes first; whether the language becomes uniform is a result, not the goal.

Every multi-language boundary that stays long-term must be able to answer "why does this boundary need this language". Without an answer, it is treated as maintenance debt to converge.

## 3. Repository-agnostic

Generic Action Worker control logic must never contain:

```text
if repository == ...
if project == ...
if product == ...
```

An equivalent central project mapping table that stores project-specific build / test / deploy recipes is forbidden as well.

Project scripts and project parameters belong to the business repository. Action Worker reads the project's execution needs from the standard execution manifest, and a generic executor runs them.

Repository allowlists and capabilities are runtime configuration and do not enter the source code.

## 4. Execution Request

A caller submits only the task identity and the target, never a central execution conclusion.

Long-term minimal semantics:

```text
schema_version
request_id
repository
source_sha
operation
```

A caller must not submit:

- central secrets;
- tokens;
- gate conclusions;
- risk conclusions;
- actual runner names;
- self-hosted labels;
- central permission conclusions;
- any dynamic command that could bypass the manifest.

Project test, build and deploy commands may live in the version-controlled execution manifest or in project scripts.

## 5. Execution Manifest

A business repository may describe:

```text
operation
runner_profile
commands
matrix
artifacts
timeout
capability_requests
```

A manifest is a capability request, not a capability grant.

A business repository may request, for example:

```text
source.read
artifact.write
release.publish
deployment.production
```

Whether a request is granted, which secrets it maps to, and which trust domain and runner it uses are decided by Action Worker.

## 6. Trust domains

### Control

Allowed: reading GitHub metadata, Validate / Inspect / Plan, AI agents, Repository Policy, status write-back and controlled API operations.

Directly executing untrusted PR code is forbidden.

### Sandbox

Allowed: checking out an immutable source SHA, running project test / build / verify, and producing artifacts and evidence.

Forbidden: production secrets, central management tokens, unnecessary cross-repository write access and direct writes to production.

### Privileged

Only for controlled execution that really needs production credentials, a private network or high-privilege resources. Privileged tasks fail closed and must never fall back to a lower trust level because the target runner is unavailable.

## 7. CI and PR Governance

Project tests are part of the product specification, so the test code stays in the business repository; where they run converges on Action Worker:

```text
PR / push
→ thin dispatch
→ Action Worker
→ checkout immutable source
→ deterministic Security Gate
→ Sandbox CI / test / build
→ CI Evidence
→ deterministic PR Governance
→ validate-merge

                  └→ AI Review after gate
                     findings / suggestions only

merge
→ main update
→ Main Write Guard
→ trusted main SHA
```

A business repository must not keep a second heavy runner flow for "local CI".

Source-owned CI control is also updated only through PR governance; writing `main` directly to fix CI is forbidden. An ordinary PR always runs the trusted CI control from the default branch. Only a same-repository PR from a maintainer whose GitHub `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` may use its own immutable head SHA as candidate CI control for self-verification when it changes `.github/execution-manifest.json`, `.github/scripts/central-ci.sh` or `.github/scripts/central-ci.ps1`. A fork or untrusted author that changes CI control fails closed.

Candidate CI control still runs in the sandbox: it never receives production secrets, central management tokens or privileged runner access. Candidate control reaches the default branch only after it passed the Security Gate, Central CI and `validate-merge`.

PR Intake must be idempotent for the same `repository + PR + head SHA`. Before it sends a Governance or Dependency Repair dispatch, Intake first publishes a pending reservation with a short lease; later scans must not dispatch again while the lease is valid or the corresponding central run is still running. Idempotency for repeated dispatches of the same head must not rely on runs cancelling each other, because that produces false failures and wastes CI minutes.

Central main-branch CI must be idempotent for the immutable `repository + head SHA` as well. Before CI Intake sends `run-central-ci-ref`, it first publishes a `CI Evidence=pending` reservation with a short lease; it must not dispatch again while the lease is valid or the corresponding central run is still running. Repeated requests for the same main SHA must not cancel each other; a later request that finds a successful `CI Evidence` for that SHA reuses the evidence and skips the heavy CI. PR CI may still let a new head cancel an old head, because that is stale work whose source identity has changed.

The only canonical commit status context of central CI is `CI Evidence`. No alias such as `ci-evidence` or `ci_evidence` may be published alongside it; every read, wait, Release/Deploy gate and audit refers to the same standard name.

The GitHub ruleset of a public repository requires the central `validate-merge` status published by Action Worker directly; business repositories no longer start a local runner to create a check of the same name. For private repositories on the Free plan, the Main Write Guard enforces the same central status as provenance after the fact.

## 8. Release

Project build / package / deploy scripts stay in the project repository; heavy execution happens in Action Worker.

```text
immutable source
→ central build
→ package / sign / SBOM / verify
→ release-manifest
→ release-provenance
→ Release Governance
→ publish
→ re-download verification
→ finalize or rollback
```

A business repository holds no write credential for the target distribution repository. Old business-repository artifact paths of the migration period may only shrink and must not grow into a new long-term architecture.

## 9. Deploy

Production deployment uses the same execution contract:

```text
immutable source
→ central source gate
→ project deploy validation
→ Runner Resolver
→ privileged execution when required
→ health verification
→ rollback
```

A business repository owns its deploy scripts, not production secrets or the runner mapping. When a deploy needs a private network, SSH, Tailscale or other production access, it can resolve to a trusted self-hosted runner; the business repository still declares only a generic runner profile / capability request.

## 10. Runner

A business repository must not name an actual image such as `ubuntu-24.04`, `self-hosted`, a runner label, a runner group, a hostname or a cloud instance name.

A business repository declares only `runner_profile`. The Action Worker runner resolver decides the actual backend: GitHub-hosted, self-hosted or a future backend.

Self-hosted is a formally reserved backend, not a project special case.

## 11. AI Agent

An AI agent is a generic dynamic capability. It owns no permission boundary and no merge gate.

`AW_AI_AGENT_CONFIG` is the single runtime configuration for switching agents on and off and for their logical models. Policies and rules store deterministic rules and no second model selection.

AI Review reviews, suggests and finds problems. It must run after the deterministic PR gate conclusion. It may report critical / high / medium / low findings, but a finding by itself can never make CI, PR Governance, validate-merge or the Main Write Guard fail; an unavailable model, a timeout or a review engine failure must not change or delay the deterministic gate conclusion either.

The real threshold is set by repeatable CI, PR Policy, the Security Gate, Release / Deploy Policy and provenance. Agents may take part in planning, triage, review, writing and similar tasks, but cannot change secret boundaries, bypass capability grants or CI Evidence, change runner trust levels or lower the gate.

## 12. Main Write Guard

`validate-merge` is the merge authority before `main`; the Main Write Guard is the provenance authority after `main` is updated.

Every formal Release, Deploy, Publication and privileged execution requires that the target source SHA has a Main Write Guard success. Being on `main` alone is not a trusted origin.

The authoritative execution of the Main Write Guard must not depend on business repository Actions: Action Worker periodically audits the current `main` of every managed repository in the Repository Policy. A push dispatcher in a business repository can only be an optional real-time shortcut and is not a security prerequisite.

See [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md) for the detailed rules.

## 13. Repository policy

Repository permissions are managed by the single `AW_REPOSITORY_POLICY`.

Integrating an ordinary repository should need no more than:

```text
register repository capability
→ configure thin dispatch
→ provide Execution Manifest / project scripts
→ run
```

If adding an ordinary repository still requires a change to Action Worker core scripts or a project-specific policy, that is an architecture regression.

## 14. Directory boundary

Allowed long-term structure:

```text
.github/workflows/   platform entrypoints
docs/                governance documentation
contracts/           machine contracts
policies/            deterministic policy
rules/               AI review rules
scripts/             generic execution/control logic
tests/               governance regression tests
```

Central configuration directories named after a repository or project are forbidden. `runner_profile` is a contract concept; it does not allow a project-specific `profiles/` configuration layer.

## 15. Migration rules

The current code does not yet meet every target boundary, so older migration-period implementations may exist, but they must follow these rules:

1. A new capability must not grow heavy execution in business repositories further;
2. A new repository uses central execution by default;
3. An old business repository workflow may only shrink and must not gain new heavy steps;
4. Project-specific build/deploy mappings in Action Worker migrate step by step to manifests and generic executors;
5. Runner selection converges step by step on the runner resolver;
6. Documentation must distinguish the "current implementation" from the "long-term boundary".

## 16. Shortest principle

> The business repository describes what to do; Action Worker decides whether it may be done and how to do it safely, and executes it; a runner only provides compute; the gate trusts only verifiable results bound to an immutable source.
