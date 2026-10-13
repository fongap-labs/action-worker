<div align="center">

# Action Worker

**GitHub automation orchestration and governance control plane**

Task Dispatch · AI Agents · PR Governance · Release Governance · Deployment Governance

[**English**](README.md) · [简体中文](README.zh-CN.md)

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-32-1A61FE?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-118-0527FC?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-553-212183?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-9-08872B?style=flat-square)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

<sub>Metrics: Task Dispatch = successful Handle Task Dispatch runs · AI Review = successful AI Review executions · PR Governance = successful Handle PR Dispatch runs · Release Governance = successful Handle Release Dispatch runs</sub>

</div>

---

## What is Action Worker?

Action Worker is the central automation hub for the Fongap Labs GitHub repositories. It decides whether a change may be merged, released or deployed, and it runs the shared jobs (tests, builds, AI review) so that product repositories do not need their own pipelines.

Think of it as a referee and a workshop:

- A product repository **declares** what should happen.
- Action Worker **verifies** the facts on GitHub, **decides** whether the action is allowed, and **runs** it.
- A runner is only the compute that does the work. It holds no authority.

## Capabilities

| Capability | Purpose |
|---|---|
| **PR Governance** | Checks each pull request, collects CI evidence and writes the `PR Governance` status and the `validate-merge` merge gate |
| **Task Dispatch** | Runs trusted project tasks on a pinned, immutable commit |
| **Release Governance** | Builds artifacts centrally, verifies them, publishes them and rolls back on failure |
| **Deploy Governance** | Deploys a source commit through a source-owned script after provenance checks |
| **Main Write Guard** | Proves that every `main` commit came from a merged PR that passed the gate |
| **AI Review** | Optional and advisory. It never changes a gate result |
| **Agent Skills** | Shared execution rules that AI agents follow when they work on these repositories |

## How a pull request is governed

```text
PR opened or updated in a managed repository
  ↓  thin dispatch (no governance logic in the product repository)
Action Worker re-reads the PR base, head, title and diff from GitHub
  ↓
Security gate → CI evidence (tests run in a sandbox) → deterministic policy
  ↓
validate-merge status (the only merge authority)
  ↓  only after the gate passed
Optional AI review → advisory summary
```

Action Worker never trusts values that a caller supplies for the base SHA, head SHA, gate result or model. It reads them from GitHub.

## Quick start

### Integrate a repository

1. A maintainer adds the repository and its capabilities to the `AW_REPOSITORY_POLICY` repository variable.
2. Copy [`templates/pr-dispatcher/dispatch-pr-governance.yml`](templates/pr-dispatcher/dispatch-pr-governance.yml) into the repository unchanged. It is an approved template and must stay byte-identical.
3. Add `.github/execution-manifest.json`. It describes what to run and names a `runner_profile`, never a concrete runner.

Full steps and the required secrets: [Integration guide](docs/INTEGRATION_GUIDE.md).

### Work on Action Worker

```bash
npm ci
npm run check   # typecheck, lint and the test suite
```

Requires Node.js 24 or later, as declared in `package.json`.

## Design principles

- **Deterministic rules decide; AI advises.** Policy, contracts and CI evidence are the merge authority.
- **Callers name the target; Action Worker verifies the facts.**
- **No repository-specific logic.** Action Worker never branches on a repository or project name.
- **Secrets stay out of untrusted code.** Sandboxes that run pull-request code receive no central credentials.

## Documentation

- [Documentation index](docs/README.md): all governance, architecture and guide documents
- [Shared governance](docs/SHARED_GOVERNANCE.md): authority order and shared rules
- [Architecture](docs/ARCHITECTURE.md) and [architecture governance](docs/ARCHITECTURE_GOVERNANCE.md)
- [Integration guide](docs/INTEGRATION_GUIDE.md): onboarding a managed repository
- [Development guide](docs/DEVELOPMENT_GUIDE.md): validation and PR flow
- [Agent guide](CLAUDE.md) and [Agent Skills](skills/README.md)
- [Security policy](SECURITY.md)

Chinese overview: [README.zh-CN.md](README.zh-CN.md)

## License

[MIT](LICENSE)
