# Architecture

Action Worker is the GitHub automation control plane of Fongap Labs.

Long-term boundaries are defined by [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md). The unified execution contract is in [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md), and the runner and self-hosted boundary is in [RUNNER_POLICY.md](RUNNER_POLICY.md). This document describes the current implementation and the next step of convergence.

## 1. Core model

```text
Validate → Inspect → Plan → Execute → Gate → Advisory Review
```

The current implementation already provides most of this foundation:

```text
PR Policy
  Detect → Resolve → Security / CI Evidence → Deterministic Gate
                                      └→ Advisory AI Review

Task Dispatch
  Validate → Execute → Stage → Publication Gate → Publish

Source
  PR Gate → Merge → Main Write Guard → Trusted Source

Release
  Dispatch → Source Evidence → Artifact Verify → Target Gate → Publish

Deploy
  Source Gate → Deploy Gate → Execute

Self CI
  Validate → Gate
```

The next stage does not add project-specific rules. It keeps converging these entry points onto one set of generic contracts.

## 2. Central boundary

```text
Action Worker
= generic rules
+ caller validation
+ unified execution orchestration
+ runner resolution
+ AI Review
+ Gate
+ Source / Release / Deploy control

Business repository
= product code
+ test code
+ project-level build / package / deploy scripts
+ source-owned manifests (Execution / Release / Deploy)
+ the thinnest event trigger where still needed during migration
```

Action Worker keeps no project directories, no project-specific test mappings and no execution logic that branches on a repository name.

Concrete repository names do not enter the source code. Repository permissions are read from one Repository Variable, `AW_REPOSITORY_POLICY`; a repository can be granted the `pr`, `task`, `release-source` and `release-target` capabilities.

## 3. PR

The default entry point is `pr-intake.yml`. It periodically scans the open pull requests of the managed repositories in `AW_REPOSITORY_POLICY` and submits one governance task per pull request to `handle-pr-dispatch.yml`. Business repository Actions are not a security prerequisite.

During migration, the thinnest `repository_dispatch` trigger is still allowed as a real-time shortcut. It must not hold naming rules, agents, models, gate thresholds, central secrets or review rules, and it must not do heavy execution.

```text
Managed repository PR
  ↓
Action Worker PR Intake
  ↓
handle-pr-dispatch
  ↓
Validate → Inspect → Plan → Security / CI / PR Gate
  ├→ AW_CONTROL_TOKEN → deterministic status on the target PR
  └→ after the gate passed: repository_dispatch run-pr-review
        ↓
     handle-pr-review: AI Review → advisory summary
```

AI Review is a separate workflow, `handle-pr-review.yml`, which `handle-pr-dispatch` starts only after the gate passed. There are two reasons: the gate run ends as soon as the gate conclusion exists, so AI queueing or review never holds it; and the AI review queue contains only runs that really are in review, never one that is still waiting for CI.

The review workflow does not trust what the sender claims. It re-reads the current PR head and confirms that this head carries a `PR Governance` success published by Action Worker. It skips the review when the PR head has moved, when the PR was closed without merging, or when the gate does not hold. It has no step that writes a gate status.

A review is usually slower than CI, and a PR is often merged before its review ends. A merged PR does not invalidate the review: the review completes and its comment is still posted. Only an abandoned PR (closed without merging) skips the review.

The PR Task contract is `contracts/pr-task.json`:

```text
schema_version
request_id
repository
pr_number
```

When Action Worker receives a task it must:

- validate the target repository against the `pr` capability in `AW_REPOSITORY_POLICY` first;
- re-read the PR base/head SHA, title, state and diff from GitHub with `AW_CONTROL_TOKEN`;
- after checking out `refs/pull/<n>/head`, align once more with the current PR facts on GitHub. If the PR changed between dispatch and checkout, the base/head/title that agree with both the checked-out commit and the latest PR API become the facts of this run, so a synchronisation window is not mistaken for a permanent failure;
- only read the target PR and never execute code the PR provides;
- check the PR author before dispatching central CI (`scripts/pr-trust.ts`). An author with write access to the target repository (`author_association` is OWNER / MEMBER / COLLABORATOR) continues directly. A `dependabot[bot]` PR from a branch of the same public repository also continues directly (the sandbox of a public target holds no credential). A PR from any other author (for example a fork contributor, or Dependabot in a private repository) first needs an Approve review of the **current head commit** by a maintainer with write access. While it waits, the run itself succeeds, `PR Governance` and `validate-merge` are written as `failure` with the fixed description `Awaiting maintainer approval of the current head commit`, and the PR comment lists the steps. `pr-intake.yml` recognises that description and does not dispatch again until it detects an approval of the current head (within about 5 minutes; running PR Intake from the Actions tab continues at once). The approval is bound to the reviewed commit; a later push by the author needs a new approval. `central-ci-dispatch.yml` repeats the same check before it executes anything and always fails closed on an untrusted head;
- when the execution plan requires CI, check out the immutable target head SHA in Action Worker and run the project manifest / test scripts in the sandbox to produce real CI Evidence;
- form the gate conclusion from deterministic PR / Security / CI evidence first, and write one `PR Governance` status to the target head commit;
- let AI Review read CI Evidence only after the gate conclusion exists, as untrusted execution evidence; no text in the evidence is ever treated as an instruction;
- run AI Review against the centrally configured OpenAI-compatible AI endpoint; it only publishes findings and suggestions and never takes part in or delays the gate. Providers, key pools, fallback and quota policy are not Action Worker authority;
- keep the AI Review summary independent of the deterministic gate status.

A caller must not supply the base SHA, head SHA, agent, model, risk or gate conclusion.

## 4. Trust domains

`policies/execution.json` defines two stable boundaries.

### Control

May use central secrets such as the AI Gateway key, but must not execute PR code.

### Sandbox

May execute PR code, build and test, but never receives central secrets or deployment credentials.

The sandbox jobs of central CI live in `central-ci-sandbox.yml` (a reusable workflow). Sandbox jobs reference no central secret directly. A public target is checked out with the run's read-only `github.token`; only for a private target does the caller pass `checkout_token`, which is the read-only `AW_CHECKOUT_TOKEN` (`Contents: Read` only, limited to private managed repositories). GitHub evaluates it on the server side, and a public target receives an empty value. Jobs that execute target source (the sandbox and the dependency repair compute job) must not reference `AW_CONTROL_TOKEN` or `AW_ADMIN_TOKEN`. Every `actions/checkout` uses `persist-credentials: false`; the only exception is `update-work-metrics.yml`, which has to commit. The CodeQL job of `security-scan-dispatch.yml` carries no secret and only produces a SARIF artifact; a separate `publish` job holds `AW_ADMIN_TOKEN` and uploads it. `tests/workflow-invariants.test.ts` turns these boundaries into tests.

Therefore:

```text
The plan may be dynamic
Permission boundaries may not
```

## 5. Detect and Plan

Every PR first produces one Change Record:

```text
change_type = feat / fix / docs / style / refactor / perf /
              test / build / ci / chore / revert

attributes  = breaking / security / migration
```

`validate-change-record.ts` builds and validates this record from the PR title and the CHANGELOG.

`detect-pr-context.ts` then builds the technical context from this evidence:

```text
Git diff
repository markers
CHANGELOG
```

`change_areas` only states which technical regions the change touched (source / workflow / test / script and so on); it is not a change category.

`resolve-pr-plan.ts` produces:

```text
checks
tests
naming_required
review_required
review_agent
review_model
review_rule
review_llm_timeout
review_task_timeout
review_concurrency
triage_required
triage_model
triage_timeout
review_effort
route_severity
```

These remain a generic plan. It must never contain:

```text
if repository == delta
if repository == ai-gateway
...
```

Future dynamic understanding, historical baselines and dual agents may only strengthen the plan; they cannot change this boundary.

## 6. Tests

`policies/checks.json` and `policies/tests.json` describe generic verification categories.

Project test code stays with the product code, but heavy execution converges on the Action Worker sandbox.

Action Worker decides:

```text
whether this change needs CI evidence
which generic test categories it must cover
which runner_profile to use
how to produce CI Evidence bound to the source SHA
whether the gate is finally satisfied
```

Action Worker does not copy project test implementations and keeps no project mapping of the form "repository X must run command Y". Project commands and platform requirements are described by the version-controlled execution manifest and project scripts.

Target model:

```text
repository event
→ Action Worker
→ checkout immutable source
→ Sandbox test / build / verify
→ CI Evidence
→ PR Governance
→ validate-merge bridge when required
```

When `ci_required=false`, Action Worker still writes an explicit successful "CI not required" evidence. A missing evidence never means "not required".

If a GitHub ruleset forces a business repository to create a `validate-merge` check, it keeps only a very thin bridge that joins the central `CI Evidence` and `PR Governance`; it must not run project tests any more.

The old business-repository CI runners of the migration period are a path to be removed. They may only shrink and must not serve as a template for a new repository.

## 7. AI Agent Runtime

An AI agent is a generic dynamic capability unit of Action Worker. It is not the same as a code review role and is not bound to a model.

Agents that may exist today include, but are not limited to:

```text
triage
review
writing
```

More can be added later:

```text
research
documentation
planner
critic
security
summary
...
```

Adding an agent must not require a new model variable, a new switch variable or a project-specific configuration layer.

### 7.1 One runtime configuration

Switching agents on and off and choosing their logical models is controlled by one Action Worker Repository Variable:

```text
AW_AI_AGENT_CONFIG
```

Example:

```json
{
  "schema_version": 1,
  "agents": {
    "triage": {
      "enabled": true,
      "model": "Code-Air"
    },
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
    "writing": {
      "enabled": true,
      "model": "Pro"
    }
  }
}
```

Without this configuration every optional AI agent is off. When an agent has `enabled=false` it does not run and must not become a dependency of the gate.

`model` is the agent's default logical model; `routes` override it only where one agent really needs different models. Review can route by audit type (code / workflow / release / security / architecture), and Writing can add routes for different writing tasks later, without changing the structure of the global variable.

### 7.2 Policy separate from models

`AW_AI_AGENT_CONFIG` only answers:

```text
whether an agent is enabled
which logical model the agent uses
which logical model a route inside the agent uses
```

Deterministic rules stay in policies and rules, for example:

```text
policies/review.json
policies/triage.json
rules/*.json
```

These files hold review scope, priority, timeouts, resume budgets and rules; they hold no model names. Model selection and governance rules must not become two authorities.

### 7.3 Agents in PR governance

The PR plan makes the deterministic decisions first. A PR enters AI Review only when the `review` agent is enabled. With `review.enabled=false`, the PR still runs naming, CI Evidence, the Change Record and the other deterministic gates, and never fails because AI is unreliable.

`triage` is a separate agent. It takes part in routing only when it is enabled itself and a review is really needed; triage alone cannot switch a disabled review back on.

Review routes available today:

```text
code
workflow
release
security
architecture
deep
```

These are review routes, not global agent types. A future audit type such as documentation, compliance or quality only extends the review routes and their rules; it does not introduce a new global model variable.

### 7.4 Writing and other agents

Writing is a peer of Review, not a part of it. Task Dispatch provides the Action Worker Repository Variables to trusted downstream tasks as runtime configuration, so the Writing agent reads the same `AW_AI_AGENT_CONFIG` instead of keeping a second set of writing model variables.

So that every downstream bootstrap does not parse the JSON again, Action Worker derives read-only environment variables from `AW_AI_AGENT_CONFIG` when Task Dispatch runs. They are not GitHub Repository Variables and not a second configuration authority:

```text
AW_AI_AGENT_<AGENT>_MODEL
AW_AI_AGENT_<AGENT>_<ROUTE>_MODEL
```

For example:

```text
AW_AI_AGENT_WRITING_MODEL
AW_AI_AGENT_WRITING_MARKET_BRIEF_MODEL
AW_AI_AGENT_WRITING_PHARMA_BRIEF_MODEL
```

Runtime variables exist only for enabled agents. A disabled agent produces no model value, so whatever refers to it fails closed. If a Repository Variable defined by hand collides with one of these derived names, Task Dispatch must refuse to run, so `AW_AI_AGENT_CONFIG` stays the only model authority.

Later agents such as Planner, Critic, Research and Summary follow the same principle:

```text
one agent runtime configuration entry
→ every agent enabled on its own
→ every agent with its own logical model
→ routes inside an agent where needed
→ the task runtime only consumes derived model values
```

### 7.5 AI endpoint and review engine

Action Worker only selects a logical model and calls the centrally configured compatible AI endpoint. It keeps no providers, key pools, nodes or model-family fallback. The endpoint can currently be provided by AI Gateway, but that product is not an architectural dependency of Action Worker.

When the Review agent is enabled, OpenCodeReview is the current review engine. Action Worker never retries a whole OCR review round without bound: OpenCodeReview retries individual LLM requests, and the endpoint back end handles provider and model fallback. If OCR already produced a compatible session and the final failure came only from a 5xx, a timeout, the network or overload, Action Worker runs `--resume` within the limited resume budget in `policies/review.json`. When a review is finally unavailable, only "advisory unavailable" is recorded; the deterministic merge gate does not change.

In PR Governance, Triage and Review keep sharing one controlled FIFO queue so that several governance runs do not use the central AI endpoint at the same time. This queue belongs to the PR AI execution policy; it does not require Writing or future independent tasks to use the same queue.

### 7.6 Evidence and gate

A PR that needs CI first forms structured CI Evidence and completes the deterministic gate. AI Review may read the evidence only after the gate conclusion, as review support, and must never treat text in the evidence as an instruction.

AI agents are an optional dynamic review layer, not a gate layer. AI findings, model failures, review engine failures or "AI unavailable" can never make the merge gate fail by themselves. The final gate trusts only repeatable PR Policy, the Security Gate, CI Evidence, Release / Deploy Policy and provenance. No agent may change permission boundaries, secret boundaries, the authenticity requirement of CI Evidence or the deterministic gate contract.

## 8. Main Write Guard

After a PR merges, every update of `main` passes the one Main Write Guard. It re-queries the current facts on GitHub and proves that the current main SHA comes from a merged PR that passed the deterministic gate.

```text
validate-merge
→ merge
→ main update
→ Main Write Guard
→ trusted main SHA
```

A main SHA whose origin cannot be proven fails closed: Release, Deploy, Publication and privileged execution are refused.

See [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md) for the detailed rules.

## 9. Task Dispatch

The existing `run-task` stays stable.

The contract is `contracts/task-dispatch.json`:

```text
schema_version
request_id
project
bootstrap_ref
```

`bootstrap_ref` must be a full 40-character commit SHA.

Tasks and PRs share one principle:

> The caller submits a target; Action Worker verifies the facts and decides how to execute.

A task uses `AW_CONTROL_TOKEN` to fetch the pinned commit of a managed private repository. Once the bootstrap is downloaded, central credentials such as `AW_CONTROL_TOKEN`, `AW_ADMIN_TOKEN`, `AIG_ACCESS_KEY_AGENT` and `AW_DISPATCH_TOKEN` are removed from the business execution environment. The bootstrap is then started with `exec`, which replaces the shell that was started with every secret, so the task never runs beside that process. When the task source repository is private, the bootstrap output goes to a runner temporary file instead of this public repository's run log; the log keeps only a summary of the task result, and the file leaves the runner only encrypted (section 9.4). A task may stage one cross-repository publication request in `RUNNER_TEMP/action-worker-publication`, but the business task holds no write credential for the target repository. After the task succeeds, Action Worker separately checks `AW_REPOSITORY_POLICY`: the source repository needs `release-source`, and the target repository needs `release-target` and `pr`. Only then is `AW_CONTROL_TOKEN` injected into the central publication step, which merges into the target repository's `main` through a pull request (`main` of the target has no bypass and requires a PR with a passing `validate-merge` check).

### 9.1 Task source re-verification

A `run-task` payload is only the caller's claim. After validating the payload, the `validate` job of `handle-task-dispatch.yml` calls `scripts/validate-task-source.ts`, so the receiving side re-checks the facts with the same rules as the deploy path:

- `bootstrap_ref` must equal the current HEAD of the target repository's default branch; a stale ref fails with exit code 75, and the next dispatch handles the new HEAD;
- the commit must carry `CI Evidence` that passes re-verification. A push-triggered task can arrive before the main-branch CI, so it waits up to about 20 minutes and fails only if no successful evidence appears;
- the commit must pass the Main Write Guard (`assertTrustedMainWrite`).

The `execute` job depends on `validate`. When re-verification fails the task never starts, so the secret scope declared by that commit is never resolved.

`CI Evidence` itself is only a commit status: any account that can write commit statuses can set a `target_url` that starts with a control repository run URL. The PR gate (`wait-ci-evidence.ts`, and `dispatch-central-ci.ts` when it decides whether CI can be skipped), deploy admission, task admission and the Main Write Guard therefore do not stop at the prefix. They re-check with `hasVerifiedCiEvidence` in `scripts/ci-evidence.ts`:

- the status must be `success` and its `target_url` must point at a run of the control repository;
- that run must belong to a workflow that publishes this status (`central-ci-dispatch.yml` or `handle-pr-dispatch.yml`), run on the default branch, and be completed and successful; while the run is still finishing, the check briefly waits for the conclusion;
- the status must have been created inside the run's time window, so a status cannot point at an unrelated old successful run.

Because the conclusion is judged for the whole run, `central-ci-dispatch.yml` dispatches its follow-ups after `finalize` (which writes `CI Evidence`) — the security scan dispatch, the Main Write audit and the automatic deploy dispatch — from a separate `follow-up` job with `continue-on-error: true`. A failing follow-up cannot turn a passing CI run red, so the PR gate never rejects a real CI result because of one. Deploy admission still checks the Main Write Guard on its own.

GitHub returns `null` in the `creator` field of these commit statuses, so the check does not rely on the creating account. The release path (`validate-release-build-request.ts`, `publish-release.ts`, `sync-tool-release.ts`) still uses the older status check and will be unified later.

### 9.2 Central task secret list

A task source repository declares the secret names a task may keep in `projects/<project>/.secrets.required` and `.secrets.allowed`, but those files live in the commit of the party being executed. `policies/task-secrets.json` records, per repository and project, the ceiling of names it may declare (the union of `required` and `allowed`); a repository or project that is not listed has an empty ceiling.

When `scripts/resolve-secret-scope.ts` receives the policy path, repository and project, it compares the names the task source declares with that ceiling. `AW_TASK_SECRET_POLICY_MODE` (Repository Variable, default `warn`) decides what happens to names beyond it:

- `warn`: the task continues, and the log lists the excess names with `::warning::`;
- `enforce`: the run fails with exit code 65 and the task does not start.

Update `policies/task-secrets.json` before adding a task project or one of its secrets. Set `AW_TASK_SECRET_POLICY_MODE` to `enforce` once the `warn` logs show no unexpected excess.

### 9.3 Secret aliases

A source declares the secret name its code reads, for example `CLOUDFLARE_API_TOKEN`. When one name has to serve several accounts, a stored secret can hold only one value per name, so the central policy can give a task project or a deploy environment an **alias**: `"aliases": { "CLOUDFLARE_API_TOKEN": "CLOUDFLARE_API_TOKEN_SECONDARY" }` in `policies/task-secrets.json` or `policies/deploy-secrets.json`. The workflow then sets the declared name to the value of the stored secret named in the alias, before it removes every other secret; the source code, its `.secrets.required` / `.secrets.allowed` lists and its entrypoint do not change.

- The stored secret of the declared name itself is never a fallback: an aliased name whose stored secret is missing fails (required) or is removed (optional), because the plain name may hold another account's token.
- The alias target must not be a reserved name, must not be declared by the source, and cannot be shared by two aliases. The aliased name must be one the policy lists for that project or environment.
- Today `CLOUDFLARE_API_TOKEN_PRIMARY` serves the internal-vault tasks FongapBlog and FongapCDN, and `CLOUDFLARE_API_TOKEN_SECONDARY` serves the ai-gateway deploy. Both are stored in action-worker like every other secret.

### 9.4 Private task state and logs

Artifacts of this public repository can be downloaded by any signed-in GitHub user. For a private task source, the task state (`task-state-<hash>`) and the log of a failed task (`task-log-<run>`) therefore leave the runner only encrypted with the secret `AW_ARTIFACT_KEY` (AES-256-GCM, `scripts/task-state.ts`). The encryption also binds each file to its kind, repository and project, so a file cannot be swapped into another task.

- Without `AW_ARTIFACT_KEY`, nothing private is uploaded: the task runs without previous state and its failed log stays on the runner.
- The task never keeps the key: `AW_` names are reserved in the secret scope, and the execute step fails if the key is still in its environment.
- State is looked up by its artifact name and accepted only from a successful run of `handle-task-dispatch.yml` on `main`; its manifest is checked again after decryption.

Reading a failed private task log (the owner, with the key file kept when the secret was created):

```bash
gh run download <run-id> -R fongap-labs/action-worker -n task-log-<run-id>-1 -D task-log
AW_ARTIFACT_KEY="$(cat ~/aw-artifact.key)" node scripts/task-state.ts open-log task-log/task-log.seal <owner/repository> <project> task.log
```

## 10. Source and Release

Source and CI admission use verifiable evidence that the central execution contract produces and `hasVerifiedCiEvidence` checks.

The target release path is centrally event-driven:

```text
immutable source
  ↓
Action Worker central build / package
  ↓
release artifact + provenance
  ↓
handle-release-dispatch.yml
  ↓
validate-release-request.ts
  ↓
publish-release.ts
```

A local source build workflow in a business repository is only a migration compatibility path and must not be used for new integrations.

Machine contracts:

```text
contracts/release-dispatch.json
contracts/release-manifest.json
```

Central Release Governance verifies:

```text
source repository allowlist
→ immutable source SHA
→ trusted central CI Evidence
→ successful artifact run
→ exact Actions artifact
→ release-manifest.json
→ declared file set
→ SHA256
→ target repository allowlist
→ scoped Tag / Release collision
→ target publish
→ re-download verification
→ publish or rollback
```

The source repository keeps the source-owned release manifest and project-level build/package scripts, and no write credential for the target repository. Action Worker produces the artifact centrally and binds the artifact run to the source commit with provenance. Action Worker uses central credentials to read the source repository, to build and verify the artifact, and to write the distribution target.

Tags are always `<release-key>-v<semver>`. There is no compatibility path for a bare `v<semver>`.

## 11. Release Build

Heavy release builds execute in Action Worker, not in business-repository runners.

```text
release-build ingress
→ source repository + optional requested version
→ resolve current immutable default-branch source
→ Action Worker source/default-HEAD/CI admission
→ central build matrix
→ central artifact package
→ release-provenance.json
→ repository_dispatch: run-release
→ Release Governance
→ external-vault Release
```

Project-specific build commands remain in the source repository as narrow scripts. Runner selection, Node/Python/Rust setup, build attestation, package-level SBOM generation, artifact aggregation, target repository, release manifest generation, provenance, publication, verification, and rollback are centrally governed.

The build matrix is resolved from the source-owned release manifest. Release targets and publication authority remain centrally governed; project build recipes must not be duplicated into a permanent repository-name mapping.

## 12. Tool Distribution

Third-party tool metadata remains authoritative in the distribution repository:

```text
external-vault/tools/catalog.json
→ tools/<tool>/tool.json
```

Action Worker owns scheduled synchronization and verification:

```text
tool catalog + metadata
→ upstream stable Release
→ upstream checksum / digest / license verification
→ release-manifest.json
→ release-provenance.json
→ Action Worker artifact
→ Release Governance
→ distribution repository Release
```

Business repositories do not run upstream download, checksum verification, packaging, or tool Release dispatch workflows. Tool metadata stays text-only in the distribution repository; executable payloads stay in GitHub Releases.

The review engine that Action Worker executes is pinned in `policies/review.json` by `version` and `sha256`. The installer accepts a binary only when its digest equals the pinned value and the release checksum file agrees, so a replaced release asset cannot vouch for itself. Moving to a new engine release means updating both fields in one reviewed change.

## 13. Deploy

Production deployment follows the same immutable-source boundary as Release Governance, but deploy execution does not publish a GitHub Release.

```text
business repository main
→ Central CI
→ trusted CI Evidence
→ immutable deploy request
→ Action Worker source gate
→ project deployment validation
→ production deploy
→ health verification
→ rollback on failure
```

Action Worker owns production credentials and runner-heavy deployment orchestration. The source repository owns only product code and project-specific deployment tooling. A deploy request cannot supply mutable refs, arbitrary repositories, CI conclusions, or deployment credentials.

The generic source-script deploy executor requires the current default-branch HEAD, trusted Action Worker `CI Evidence`, Main Write Guard success, a privileged runner profile, and the source-owned deploy manifest. Product-specific emergency switches such as `AIG_IS_DEPLOY_ENABLED=false` remain inside the source-owned deploy entrypoint.

The executor unsets every secret outside the source-declared scope and then starts the entrypoint with `exec`, replacing the shell that was started with every secret, so the entrypoint does not run beside it.

### 13.1 Deploy environments and secrets (central authority)

The deploy manifest (`.github/deploy.json` in the source repository) only *requests* an environment. Two central policies decide what is granted:

- `policies/deploy-environments.json` lists, per source repository, the environments it may use. `validate-deploy-source.ts` checks the manifest's `environment` against it right after parsing; a repository that is not listed, or an environment that is not listed for it, fails the deploy with exit code 77 before any runner starts. A repository therefore cannot name `production`, or another repository's environment, by itself.
- `policies/deploy-secrets.json` lists, per repository and environment, the secret names the source may declare in `deploy.secrets.required` / `deploy.secrets.allowed` (the union is the ceiling), like `policies/task-secrets.json` does for tasks. `AW_DEPLOY_SECRET_POLICY_MODE` (Repository Variable, default `warn`) decides what happens to a name beyond the ceiling: `warn` prints `::warning::` and continues, `enforce` fails with exit code 65 and the entrypoint never starts. Change the policy file first, then the source's list. After a successful rehearsal deploy, set the variable to `enforce`.

The deploy job also: checks the target out with the read-only `AW_CHECKOUT_TOKEN` (never `AW_CONTROL_TOKEN`), asks `resolve-secret-scope.ts` to refuse the control-plane credentials (`AW_CONTROL_TOKEN`, `AW_ADMIN_TOKEN`, `AW_DISPATCH_TOKEN`, `AW_CHECKOUT_TOKEN`, `GH_TOKEN`, `NODE_OPTIONS`) in any declared list, and fails if one of them is still in the environment before the entrypoint starts.

Every job that uses `AW_ADMIN_TOKEN` (`apply-repository-settings.yml`, the publish job of `security-scan-dispatch.yml`) runs in the `admin-ops` environment. Both environments (`production`, `admin-ops`) restrict deployment to `main`; repository_dispatch runs always use the default branch, and a `workflow_dispatch` run from another branch is refused by the environment. Repository-level copies of secrets stay in place until the environment copies have been verified; deleting them is a separate, manual owner step.

## 14. Directory layout

Action Worker is layered by responsibility. The current workflow entry points are listed below. Business capabilities connect through generic contracts, manifests and policies; no long-lived workflow is named after a product:

```text
.github/workflows/
  # dispatch entry points: handle-<subject>-dispatch.yml, shortened to fit three segments
  handle-pr-dispatch.yml
  handle-pr-review.yml
  handle-release-dispatch.yml
  handle-task-dispatch.yml
  cancel-pr-work.yml
  central-ci-dispatch.yml
  dependency-repair-dispatch.yml
  release-build-dispatch.yml
  security-scan-dispatch.yml
  source-script-deploy.yml
  task-source-dispatch.yml

  # scheduled reconciliation that dispatches work: <subject>-intake.yml
  ci-intake.yml
  pr-intake.yml
  security-scan-intake.yml
  task-intake.yml

  # reusable and standalone operations
  apply-repository-settings.yml
  central-ci-sandbox.yml
  main-write-audit.yml
  main-write-guard.yml
  prune-stale-branches.yml
  sync-tool-release.yml
  update-work-metrics.yml
  validate-ci.yml

contracts/
  PR / Task / Release / Release Build / Deploy / Provenance contracts

policies/
  repository / execution / naming / review / release / deploy / CI policies

rules/
  architecture / code / release / security / workflow review rules

scripts/
  deterministic validation, dispatch, publication, synchronization, and governance controls

tests/
  contract, control-flow, runtime, release, deploy, CI, and regression tests

docs/
  architecture, governance, naming, changelog, development, and integration guides
```

`tests/workflow-naming.test.ts` checks the workflow names (see [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) section 8.1); the two files that keep an older name (`handle-pr-dispatch.yml`, `handle-pr-review.yml`) are recorded there with their reasons.

Project-specific configuration layers must not come back, for example:

```text
projects/<repository-or-product>/
profiles/<repository-or-product>/
<repository-name>/
```

Generic, repository-agnostic framework layers such as `executors/`, `runners/` or `adapters/` may be introduced when an implementation really needs them, but they must be driven by generic contracts and policies and must not turn into a project mapping table.

Project-specific build / test / deploy implementations stay in the business repository; Action Worker keeps only central governance, the generic execution framework and runner resolution. A business repository script that Action Worker checks out and executes does not mean the business repository runs heavy runner execution itself.

## 15. CI

Action Worker itself has a single CI: `validate-ci.yml`.

```text
naming
static
contracts
  ↓
validate-merge
```

The contracts also verify the architecture governance boundaries, so the repository does not grow project-specific configuration again as features are added.

## 16. Versions

```text
main = current baseline
```

Action Worker maintains only one long-lived line, `main`.
