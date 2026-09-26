<div align="center">

# Action Worker

**GitHub automation orchestration and governance control plane**

Task Dispatch · AI Agents · PR Governance · Release Governance · Deployment Governance

[**English**](README.md) · [简体中文](README.zh-CN.md)

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-0-1A61FE?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-25-0527FC?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-146-212183?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-1-08872B?style=flat-square)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

<sub>Metrics: Task Dispatch = successful Handle Task Dispatch runs · AI Review = successful AI Review executions · PR Governance = successful Handle PR Dispatch runs · Release Governance = successful Handle Release Dispatch runs</sub>

</div>

---

## What is Action Worker?

Action Worker is the central GitHub automation orchestration and governance control plane for multiple repositories.

It centralizes task dispatch, AI agents, PR governance, CI evidence, release governance, and deployment admission. Product repositories keep product code, tests, builds, and deployment implementation.

Callers declare the target. Action Worker verifies facts, builds a plan, runs reviews, and allows or blocks the change according to verifiable evidence.

```text
Task / PR
   │
   ▼
Validate
   ↓
Inspect
   ↓
Plan
   ↓
Evidence
   ↓
Triage
   ↓
Review
   ↓
Gate
```

Action Worker does not maintain repository-name-specific branches and does not introduce `projects/`, `adapters/`, or `profiles/`.

## Core design

### Deterministic governance × AI agents

Fixed boundaries and dynamic judgment are separated.

**Deterministic governance** is enforced by scripts, contracts, and policies:

- input contracts and caller identity;
- PR title and CHANGELOG contracts;
- naming rules;
- secrets and execution permissions;
- review blocking thresholds;
- Release SemVer, tags, and rollback;
- final gates.

**Agent review** is responsible for:

- understanding diffs and context;
- assessing code, architecture, security, workflow, and release risk;
- selecting review roles and models;
- reviewing execution results.

Agents may judge risk. They may not redefine permission boundaries or gates.

## Capabilities

| Capability | Purpose |
|---|---|
| **Task Dispatch** | Dispatch trusted tasks through fixed events, payloads, and commit SHAs; cross-repository outputs pass the central Publication Gate |
| **PR Policy** | Identify diff scope, change areas, and risk to build an execution plan |
| **AI Triage** | Run a short structured semantic triage with `Code-Air`; it may only skip extremely low-risk review or escalate review strength |
| **AI Review** | Select `code / workflow / security / architecture / release` review roles according to risk |
| **Agent Skills** | Provide one shared execution discipline plus task skills for bug fixing, CI diagnosis, impact analysis, PR review, and release verification |
| **CI Evidence** | Read execution evidence from the target repository's current head SHA through `ci.yml → validate-merge` |
| **Source Policy** | Enforce target commit, default HEAD, and successful CI admission |
| **Gate** | Combine AI Review, CI Evidence, and deterministic policy to allow or block |
| **Release** | Centralize SemVer, tags, releases, asset re-verification, and rollback |
| **Deploy** | Centralize deployment commit admission while keeping deployment implementation and production secrets in product repositories |

Normal code, workflow, and release changes first receive a short structured AI Triage by `Code-Air`. If triage fails or returns an invalid result, the deterministic plan remains in force. Only low-risk `code` changes may skip full review at high confidence; security, architecture, and deep-risk changes may only escalate review strength.

AI Review runs centrally through the [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) CLI pinned to an explicit version. Triage and Review share one global FIFO queue. Action Worker does not retry an entire review round. Request-level retry is handled by OpenCodeReview, while model-family, provider, key, protocol, and node fallback are delegated to AI Gateway.

## Quick start

### 1. PR governance

Managed repositories keep only a thin `dispatch-pr-governance.yml` trigger. It does not execute governance logic and never receives AI Gateway secrets. It only sends the smallest possible PR task to Action Worker:

```yaml
name: Dispatch PR Governance

on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited]

permissions: {}

jobs:
  dispatch:
    runs-on: ubuntu-24.04
    steps:
      - name: Dispatch central governance
        env:
          AW_DISPATCH_TOKEN: ${{ secrets.AW_DISPATCH_TOKEN }}
          REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REQUEST_ID: pr-${{ github.repository_id }}-${{ github.event.pull_request.number }}-${{ github.run_id }}
        run: |
          payload="$(jq -cn \
            --arg request_id "$REQUEST_ID" \
            --arg repository "$REPOSITORY" \
            --argjson pr_number "$PR_NUMBER" \
            '{event_type:"run-pr-governance",client_payload:{schema_version:"1",request_id:$request_id,repository:$repository,pr_number:$pr_number}}')"

          curl -fsS -X POST \
            -H "Authorization: Bearer $AW_DISPATCH_TOKEN" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            https://api.github.com/repos/${GITHUB_REPOSITORY_OWNER}/action-worker/dispatches \
            -d "$payload"
```

Managed repositories only need `AW_DISPATCH_TOKEN`, scoped to send `repository_dispatch` to `action-worker` in the same organization. The target repository is derived from `GITHUB_REPOSITORY_OWNER`. `AI_GATEWAY_URL`, `AIG_ACCESS_KEY_AGENT`, and cross-repository writeback credentials remain only in Action Worker.

All AI agent runtime configuration is centralized in the Repository Variable `AW_AI_AGENT_CONFIG`:

```json
{
  "schema_version": 1,
  "agents": {
    "triage": { "enabled": true, "model": "Code-Air" },
    "review": {
      "enabled": false,
      "model": "Code-Pro",
      "routes": {
        "release": { "model": "Code-Max" },
        "security": { "model": "Code-Ultra" },
        "architecture": { "model": "Code-Ultra" },
        "deep": { "model": "Code-Ultra" }
      }
    },
    "writing": { "enabled": true, "model": "Pro" }
  }
}
```

Optional AI agents are disabled when not configured. The current recommended baseline keeps `review.enabled=false` until deterministic governance is independently stable. Writing, Review, and future agents can be enabled independently without maintaining review-specific switches.

Repository capabilities are managed by one Repository Variable, `AW_REPOSITORY_POLICY`. Each repository is registered once and receives only the capabilities it needs: `pr`, `task`, `release-source`, `release-target`, and/or `deploy`.

```json
{
  "fongap-labs/ai-gateway": ["pr", "task", "deploy"],
  "fongap-labs/delta": ["pr", "task", "release-source"],
  "fongap-labs/external-vault": ["pr", "task", "release-target"]
}
```

Adding, removing, or changing repository permissions only changes this variable; it does not require Action Worker source changes.

The central `AW_CONTROL_TOKEN` needs Contents Read/Write, Pull Requests Read/Write, Commit Statuses Read/Write, and **Actions Read** where the corresponding central capability is enabled. Contents Write is used only by trusted Control steps such as validated dependency-repair publication, release publication, and stale-branch ref pruning. `AW_ADMIN_TOKEN` remains reserved for repository administration such as Settings, Rulesets, and SARIF publication.

Central PR flow:

```text
PR event
  ↓
repository_dispatch
  ↓
Action Worker
  ↓
Validate → Inspect → Plan → CI Evidence → Optional AI Agents → Gate
  ↓
PR Governance commit status + sticky review summary
```

Action Worker re-fetches the PR base/head SHA, title, state, and diff from GitHub. Callers cannot declare those facts. Changes that require CI first collect evidence for the current head SHA. Enabled AI agents may use that evidence, but the deterministic gate still requires `validate-merge=success`. Project tests remain in the managed repository sandbox; the central control plane never executes PR-provided code.

### 2. Task dispatch

Action Worker materializes the exact immutable task source SHA before executing source-owned code. The checkout uses central Control authority with persisted Git credentials disabled. Before `bootstrap.sh` runs, Control credentials are removed and the source task receives only the local `AW_SOURCE_DIR` snapshot plus explicitly source-declared project secrets.

`AW_EXECUTION_TOKEN` is deleted and must not be configured. Source bootstrap code does not clone its repository and does not inherit `AW_CONTROL_TOKEN`, `AW_ADMIN_TOKEN`, `AW_DISPATCH_TOKEN`, or the Agent gateway access key.

Task Dispatch accepts one fixed event:

```text
event_type = run-task
```

The payload contains only:

```json
{
  "schema_version": "1",
  "request_id": "example-001",
  "project": "example",
  "bootstrap_ref": "40-character-commit-sha"
}
```

`bootstrap_ref` must be a full immutable commit SHA. Source repositories own `.github/task-source.json`, project task contracts, entrypoints, and minimal secret scopes; scheduling and heavy execution remain in Action Worker.

### 3. Release governance

Release build and publication are centrally orchestrated. A source repository keeps its project build/package scripts and source-owned `.github/release.manifest.json`; Action Worker resolves an immutable source SHA, validates CI and provenance, selects an abstract Runner Profile, executes the declared build/package path, and produces governed release artifacts.

```text
immutable source
  ↓
source-owned .github/release.manifest.json
  ↓
Action Worker Build / Package
  ↓
release artifact + provenance
  ↓
Release Governance
  ↓
target publish
  ↓
re-download verification
  ↓
finalize / rollback
```

Source and target authority remain separate. `release-source` authorizes build inputs; `release-target` authorizes publication targets. Business repositories do not hold distribution-target write credentials.

Tags use:

```text
<release-key>-v<semver>
```

The central publisher validates the manifest and SHA256 values, publishes the declared assets and checksum files, re-downloads them for verification, and rolls back the release/tag created by that attempt on failure.

### 4. Deployment governance

Deployment is source-owned but centrally executed:

```text
immutable default-branch source
  ↓
deploy capability
  ↓
source-owned .github/deploy.json
  ↓
Central CI
  ↓
synchronous Main Write Audit
  ↓
Runner Resolver
  ↓
generic source-script executor
  ↓
source-owned entrypoint
  ↓
health verification / rollback
```

The manifest declares only deployment intent, abstract `runner_profile`, environment, and a safe source-owned entrypoint. Application secrets are explicitly scoped by `.github/deploy.secrets.required` / `.github/deploy.secrets.allowed`; Action Worker strips Control credentials before the source entrypoint runs.

Cloudflare, Server Edge, SSH, Tailscale, database migration, health-check, and rollback logic stay with the source repository. Heavy orchestration, provenance validation, privileged Runner resolution, secret isolation, and dispatch remain in Action Worker. Automatic deploy is fail-closed and runs only after successful Central CI and a trusted Main Write Guard for the exact source SHA.

## Change conventions

PRs, agents, CHANGELOG entries, and releases share the same types:

```text
feat / fix / docs / style / refactor / perf
test / build / ci / chore / revert
```

Attributes:

```text
breaking / security / migration
```

PR titles:

```text
type: summary
type(scope): summary
type!: summary
type(scope)!: summary
```

`CHANGELOG.md` updates are required by default for:

```text
feat / fix / perf / revert
```

and for every breaking change.

See [CHANGELOG conventions](docs/CHANGELOG_CONVENTIONS.md) for the complete contract.

## Security boundary

PR code is always treated as untrusted input.

```text
Control
├─ GitHub metadata
├─ diff
├─ Plan
├─ CI Evidence
├─ optional AI Agents
├─ Gate
└─ central secrets allowed

Sandbox
├─ checkout PR head
├─ build / test / verify
└─ no central secrets
```

Principle:

> Plans may be dynamic; permission boundaries and gates must remain fixed.

Managed repository CI runners execute project code as the sandbox. Action Worker Control only reads CI Evidence and never sends AI Gateway credentials, cross-repository control credentials, or deployment secrets into that sandbox.

## Documentation

- [Documentation index](docs/README.md) — shared navigation for humans and agents
- [Agent guide](CLAUDE.md) — required agent entry point and execution boundaries
- [Agent Skills](skills/README.md) — source of truth for reusable agent execution skills
- [Architecture](docs/ARCHITECTURE.md) — current implementation and convergence direction
- [Architecture governance](docs/ARCHITECTURE_GOVERNANCE.md) — long-term boundaries and governance principles
- [Naming conventions](docs/NAMING_CONVENTIONS.md) — shared naming rules
- [CHANGELOG conventions](docs/CHANGELOG_CONVENTIONS.md) — shared PR, agent, CHANGELOG, and release classification
- [Development guide](docs/DEVELOPMENT_GUIDE.md) — common development and verification flow
- [Integration guide](docs/INTEGRATION_GUIDE.md) — standard onboarding for managed repositories
- [Change Record contract](contracts/change-record.json) — machine-readable change contract
- [PR Task contract](contracts/pr-task.json) — PR Task input contract
- [Task Dispatch contract](contracts/task-dispatch.json) — Task Dispatch input contract

Chinese overview: [README.zh-CN.md](README.zh-CN.md) · [docs/README.zh-CN.md](docs/README.zh-CN.md)

## Repository layout

```text
.github/workflows/   GitHub entry points
docs/                governance documentation for humans and agents
contracts/           machine contracts
policies/            deterministic governance policy
rules/               AI review rules
skills/              reusable agent execution skills
scripts/             shared execution scripts
tests/               governance and contract tests
```

Project-specific configuration does not belong in Action Worker.

## License

[MIT](LICENSE)
