# Execution Contract

This document defines the unified execution boundary between the managed Fongap Labs repositories and Action Worker. It applies to public and private repositories alike and does not change with repository visibility.

## 1. Core principle

```text
Business repository
= source + project scripts + execution intent (tests are held by Action Worker test packs, see TEST_PACKS.md)

Action Worker
= governance + authorization + planning + execution + evidence + provenance

Runner
= disposable compute backend
```

The business repository describes "what needs to be done"; Action Worker decides "whether it is allowed, how it runs and on which kind of runner".

Apart from the thinnest event trigger and the bridge checks the GitHub platform requires, heavy execution — CI, test, build, AI Review, release, deploy and scheduled tasks — runs in Action Worker.

This rule applies to public and private repositories alike. Repository visibility may only affect the access method and GitHub platform features; it must never produce a second execution architecture.

## 2. Unified execution chain

```text
Repository event
  ↓
Execution Request
  ↓
Validate source and authority
  ↓
Resolve Execution Manifest
  ↓
Plan
  ↓
Grant capabilities
  ↓
Resolve Runner
  ↓
Execute in Action Worker
  ↓
Evidence / Artifact / Provenance
  ↓
Gate / Publish / Deploy / Status
```

A business repository must not bypass this chain with heavy workflows of its own.

## 3. Business repository owns

A business repository keeps:

- product source code;
- project tests;
- project-level build / package / deploy scripts;
- configuration templates the project needs to run;
- the execution manifest;
- the thinnest dispatch workflow;
- a very thin check / status bridge that the GitHub platform requires the target repository to create itself.

A business repository may declare execution needs, but may not declare central credentials or grant itself permissions. AI Review only provides findings and suggestions; it is not part of a capability grant, the CI gate or the merge gate.

## 4. Action Worker owns

Action Worker is responsible for:

- verifying the source and the commit identity;
- the deterministic Security Gate, including checks for newly added secrets, sensitive files and dangerous workflow patterns;
- repository capability validation;
- execution request and manifest validation;
- CI / test / build / AI Review / release / deploy / task orchestration;
- runner selection;
- injecting central secrets and tokens;
- trust domain isolation;
- artifacts and provenance;
- the gate;
- status write-back;
- publication and deployment permissions;
- the Main Write Guard and trusted main provenance;
- failure, timeout, cancellation and retry policy.

Action Worker stores no project product logic and must never choose an execution implementation by repository, project or product name.

## 5. Execution Request

A caller submits only an immutable task identity and intent. The long-term minimal semantics are:

```text
schema_version
request_id
repository
source_sha
operation
```

Where:

- `repository` must be allowed by the central Repository Policy;
- `source_sha` must be an immutable commit SHA;
- `operation` uses a generic operation type such as `ci`, `review`, `build`, `release`, `deploy` or `task`;
- the caller must not submit gate conclusions, secrets, tokens, actual runner names or central permission conclusions.

An operation may add the fields it needs in its machine contract, but must not break these boundaries.

## 6. Execution Manifest

The execution manifest always lives at `.github/execution-manifest.json` in the business repository and describes the project's own execution needs, for example:

```text
operation
runner_profile
command
matrix
artifacts
timeout
capability_requests
```

`command` is an argument array, not a concatenated shell string. The generic executor replaces only these controlled runtime tokens:

```text
{target_root}
{control_root}
{temp_root}
{matrix.<key>}
```

`control_root` is the checkout directory of the trusted execution declaration and scripts; `target_root` is the source directory of the SHA under verification. For a PR, the manifest and project scripts are read from the trusted base / default branch; a new manifest brought by the PR head is never executed directly.

A manifest may describe:

- the execution capabilities it needs, such as Linux / Windows / macOS / ARM;
- which project script to call;
- which project artifacts it needs;
- which generic capabilities it needs.

A manifest must not describe:

- GitHub token names or values;
- Cloudflare, SSH, production or other secrets;
- central management tokens;
- concrete self-hosted runner names;
- concrete runner label combinations;
- write access to any target repository;
- switches that bypass the gate.

A manifest is a capability request, not a capability grant.

## 7. Capability grant

Action Worker builds a grant from these facts:

```text
Repository Policy
+ operation
+ immutable source
+ trust domain
+ environment policy
+ requested capabilities
```

A business repository can only request a capability, never grant one to itself.

For example:

```text
release.publish
deployment.production
source.private-read
artifact.write
```

Whether a capability is granted, which secrets it maps to, and whether it may run only on a trusted runner is decided by Action Worker.

## 8. Repository-agnostic rule

Generic Action Worker control logic must never contain:

```text
if repository == ...
if project == ...
if product == ...
```

Moving project-specific execution recipes into the central repository through an equivalent project mapping table is forbidden as well.

Project-level commands and scripts stay in the project repository; Action Worker only reads the standard manifest and executes it through a generic executor.

Integrating an ordinary new repository must not require a change to Action Worker core code.

## 9. Public and private repositories

Public and private repositories use the same execution contract.

The long-term goal is a central execution ingress that receives events directly from a GitHub App, a webhook or another trusted event source and creates the execution request in Action Worker. The availability, minutes or runner state of business repository GitHub Actions must never be a precondition for central governance and execution.

The existing thinnest dispatch workflow in a business repository is only a migration path. It may trigger Action Worker for now, but must not keep running full CI, build, review, release or deploy, and must not become a long-term security prerequisite.

Target chain:

```text
GitHub repository event
→ trusted central ingress
→ Action Worker Execution Request
→ central governance / execution
```

So when a private repository runs out of Actions minutes, PR Governance, CI, Release and Deploy must not stop in the long-term architecture.

## 10. Main provenance requirement

Every operation that targets a formal environment or formal distribution must verify the Main Write Guard for its source SHA.

That includes at least:

- `release`;
- `deploy`;
- publication;
- production / privileged execution.

A `source_sha` being on `main` does not replace provenance. Only `Main Write Guard = success` bound exactly to that SHA can grant the corresponding capability.

AI Review is not part of this verification chain. AI Review runs after the deterministic PR gate conclusion and cannot change the Main Write Guard.

## 11. Migration rule

The current implementation may keep older migration-period entry points, provided that:

1. a new capability does not grow heavy execution in business repositories further;
2. a new repository uses central execution by default;
3. an old business repository workflow may only shrink and must not gain new heavy steps;
4. existing project-specific execution mappings in Action Worker migrate step by step to the generic manifest and executor;
5. documentation never describes a migration-period implementation as the long-term architecture.

Final acceptance criterion:

> A new repository, a new project or a new runner backend does not require a change to the Action Worker kernel.
