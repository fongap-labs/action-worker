# Integration Guide

This document defines the minimum requirements for a managed repository to join the Action Worker unified execution plane. Public and private repositories use the same contract.

## 1. Goal after integration

```text
Repository event
→ central intake / migration thin dispatch
→ Action Worker
→ validate immutable source
→ resolve Execution Manifest
→ authorize capabilities
→ resolve Runner
→ execute
→ evidence / provenance
→ gate / release / deploy / status
```

The business repository does not copy central governance and does not carry long-term heavy execution.

## 2. What the business repository keeps

The business repository keeps: product source code, project tests, project build / package / deploy scripts, the project architecture, the execution manifest and the thinnest dispatch.

If the GitHub platform requires the target repository to create a required check itself, it may also keep a very thin check bridge; that bridge must not run product tests or hold central secrets.

## 3. Execution Request

An ordinary dispatch submits only the task identity and the target. Long-term minimal fields:

```text
schema_version
request_id
repository
source_sha
operation
```

For a PR, the request may carry the PR number; Action Worker re-reads the real base/head SHA and diff.

A caller must not submit secrets, tokens, actual runners, gate conclusions or central permission conclusions.

## 4. Execution Manifest

The project's own execution needs are described by a version-controlled manifest and project scripts.

It may declare:

```text
operation
runner_profile
commands
matrix
artifacts
timeout
capability_requests
```

It must not declare: central secrets, a concrete self-hosted runner, runner labels, cross-repository write tokens or switches that bypass the gate.

See [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md) for the detailed contract.

## 5. CI / PR

Target model:

```text
PR
→ PR Intake / optional migration thin dispatch
→ Security / Central CI / deterministic PR policy
→ CI Evidence
→ PR Governance / validate-merge
├→ merge authority
└→ AI Review after gate (advisory only)
```

Project test code stays in the business repository, but Action Worker checks out the immutable source SHA and runs it in the sandbox.

Default-branch CI is reconciled the same way: CI Intake in the public Action Worker periodically checks the current HEAD of every managed repository and dispatches `run-central-ci-ref` when `CI Evidence` is missing. A business repository `ci.yml` is therefore only a low-latency migration entry point and no longer a long-term precondition for main CI.

A repository whose GitHub ruleset requires the check run to come from the target repository's own GitHub Actions may keep a very thin `validate-merge` bridge. It only joins `CI Evidence` and `PR Governance`.

### 5.1 Linux CI shards

By default, Linux CI is a single job that runs the business repository's `central-ci.sh` from start to finish. In a large project this one job becomes the slowest part of the pipeline. A business repository can split it into several parallel "shards" in `.github/execution-manifest.json`, so the total time becomes that of the slowest shard instead of the sum of all parts.

To do so, declare `matrix.shard` on the job with id `linux` of the `ci` operation, and pass the shard name to the script as its second argument:

```json
{
  "id": "linux",
  "runner_profile": "linux-standard",
  "command": ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}", "{matrix.shard}"],
  "matrix": { "shard": ["checks", "python", "rust"] },
  "timeout_minutes": 180,
  "capability_requests": ["source.read"]
}
```

Rules:

- A shard name uses only lowercase letters, digits and hyphens, is at most 32 characters long, and there are at most 8 shards; `all` is reserved.
- The `matrix` of the `linux` job allows only the key `shard`. Any other key, an invalid shard name or exceeding a limit fails CI immediately; nothing is silently skipped.
- A repository that declares no `matrix.shard` (including one without a manifest) is not affected: it is still one job, and the script receives exactly the same arguments as before.
- Once declared, Central CI starts one Linux job per shard and calls the script with the shard name as its second argument. Each shard must do only its own part; `CI Evidence` is success only when every shard succeeded.
- Action Worker reads the manifest only from a trusted ref (the default branch, or the candidate head when a maintainer changes CI control). How the shards are split belongs to the business repository; Action Worker keeps no shard table for any project.

## 6. Security Scan

A business repository declares its security scan intent in `.github/security-scan.json`: the CodeQL languages, an abstract `runner_profile`, the build mode, and whether to scan PRs and/or the default branch. Action Worker reads the manifest from the trusted base / default SHA, resolves the runner and runs the scan.

A PR cannot change the security scan configuration with its own head. SARIF produced by the central CodeQL must not be kept as a public `action-worker` artifact; results are uploaded straight back to the source repository from the temporary runner and then destroyed.

The CodeQL executor of the current public control plane accepts only public source repositories. Private sources fail closed until log suppression / a private security executor exists; this is a limit of the executor, not a change to the unified security scan contract.

Periodic scans are scheduled by Security Scan Intake in the public Action Worker; a business repository does not need a scheduled CodeQL workflow.

## 7. Dependency repair

Repairs such as dependency lock files or generated manifests — triggered by a trusted dependency bot and written back to the PR branch — use the source-owned `.github/dependency-repair.json`.

The boundary is fixed:

```text
trusted PR facts + base manifest
→ sandbox compute without persistent write credentials
→ output-path confinement
→ artifact handoff
→ control-plane revalidation
→ allowlisted branch write
```

The business repository declares only the adapter, an abstract `runner_profile`, the trusted actor, trigger paths, allowed outputs and tool versions. Action Worker does not choose a repair implementation by repository name.

The publication step must not run any target repository project command; it may only write allowlisted generated output back to a same-repository PR branch that still points at the same HEAD.

Before an old local repair workflow is deleted, the central path must first succeed on a real bot PR, so dependency repair never has a gap.

## 8. Runner

A business repository declares only `runner_profile` and never names a GitHub-hosted image, `self-hosted`, a runner group, labels or a hostname directly.

The Action Worker runner resolver chooses GitHub-hosted, self-hosted or a future backend.

See [RUNNER_POLICY.md](RUNNER_POLICY.md) for the detailed rules.

## 9. Central configuration

Action Worker Repository Variables:

```text
AW_REPOSITORY_POLICY
AW_AI_AGENT_CONFIG
AI_GATEWAY_URL
```

Action Worker secrets:

```text
AW_ADMIN_TOKEN
AW_CONTROL_TOKEN
AIG_ACCESS_KEY_AGENT
```

During migration a business repository may keep the minimal credential for the thin dispatch; once central PR / CI intake is in effect, that credential is no longer a long-term hard dependency of governance and execution. Central management, cross-repository write, AI Gateway and production credentials must never move down into business repositories.

`AW_CHECKOUT_TOKEN` is used only to check out private target repositories in the sandbox and in the dependency repair compute job. Its permission is `Contents: Read` only, its scope is limited to the private managed repositories, and it must be rotated before it expires. `AW_CONTROL_TOKEN` is used for central reads, control and status governance. `AW_ADMIN_TOKEN` is used only for repository-level high-privilege writes in trusted control steps, such as Repository Settings / Rulesets, and for SARIF publication, which needs Code Scanning write access. High-privilege tokens are never injected into sandbox project commands.

`AW_EXECUTION_TOKEN` has been removed and is no longer configured. Central execution combines the existing least-privilege authorities with GitHub-native short-lived credentials.

## 10. Main Write Guard

A business repository does not carry the authoritative execution of the Main Write Guard. The public `action-worker` periodically audits the current `main` of every managed repository in `AW_REPOSITORY_POLICY`, re-queries GitHub and proves that the source SHA comes from a legitimate PR merge.

A business repository may keep a very thin main-push dispatcher to shorten detection latency, but a missing dispatcher, exhausted Actions minutes or a deleted dispatcher can neither produce a trusted main SHA nor weaken the fail-closed checks of Release / Deploy.

The thinnest PR-side trigger uses `templates/pr-dispatcher/dispatch-pr-governance.yml` (only `opened` and `synchronize`, skipping Dependabot) and needs the repository to have `AW_DISPATCH_TOKEN`. It can run on a self-hosted runner; see [RUNNER_POLICY.md](RUNNER_POLICY.md) section 11.

A SHA not proven by the Main Write Guard cannot be used for Release, Deploy, Publication or privileged execution.

See [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md) for the detailed rules.

## 11. Task

Task projects stay in the business repository, but Action Worker owns the task entry point.

The business repository declares in `.github/task-source.json`:
- `push: true`: changes on the default branch must be discovered automatically by Task Intake;
- `schedules`: the mapping from schedule slots to projects.

Task Intake periodically scans every repository with the `task` capability and reads only the real default-branch HEAD. For a repository with `push` enabled, if the current HEAD has no successful `Task Source` status yet, it dispatches a changed-project resolution with the first parent commit as `before_sha`; it writes pending while running, success on success, and failure on failure so the next round retries.

A manual task is started directly from the `Task Source Dispatch` workflow_dispatch in Action Worker and submits only the managed repository and the project. A business repository no longer needs to start a local notification runner for manual or push events.

The central repository must not keep a list of business repository or project names.

## 12. Release

```text
immutable source
→ Action Worker central build/package
→ release-manifest + provenance
→ Release Governance
→ target publish
→ re-download verification
→ finalize / rollback
```

The business repository keeps the project build / package scripts and declares in `.github/release.manifest.json` the version source, build targets, assets and an abstract `runner_profile`. Action Worker reads and validates that manifest from the immutable source SHA and selects the actual runner through the central runner policy.

A project manifest must not declare central secrets, tokens or a concrete GitHub / self-hosted runner label. Publication credentials for the target repository always stay in Action Worker.

The central repository must not keep a release build matrix grouped by repository or product.

A manual release also starts from the unified Release Build workflow in Action Worker: the user only chooses the managed `source_repository` and an optional stable version; Action Worker reads the current default-branch HEAD of that repository itself and runs the same source / CI / provenance checks. A business repository does not need to start its own runner to "announce a release".

## 13. Deploy

```text
immutable source
→ deploy capability
→ source-owned .github/deploy.json
→ Action Worker source gate
→ Runner Resolver
→ adapter
→ controlled deploy
→ health verification
→ rollback
```

The business repository declares its deploy intent in `.github/deploy.json`: the `adapter`, whether to deploy automatically, the docs-only policy, an abstract `runner_profile`, the environment identifier, and the source-owned entrypoint when the adapter needs one.

Deploy permission is separate from ordinary PR permission. Action Worker resolves a deploy manifest only for a repository that explicitly has the `deploy` capability in `AW_REPOSITORY_POLICY`.

A manifest must not declare a concrete runner label, host, token or central permission. The source-owned entrypoint declares its minimal secret scope in `.github/deploy.secrets.required` / `.github/deploy.secrets.allowed`; Action Worker injects that scope only after the `deploy` capability, a trusted Main Write Guard and the privileged runner checks pass, and always strips the control-plane credentials.

`production-deploy` is an abstract privileged runner profile; the actual runner mapping is decided only by the central runner policy. It can map to GitHub-hosted today; when it moves to self-hosted later, the business repository manifest does not change.

When a deploy needs the production network, SSH, Tailscale or another trusted network, a privileged task fails closed and never falls back to a sandbox / control runner.

## 14. What an ordinary new repository should not do

Integrating an ordinary new repository should not require:

- changing Action Worker core scripts;
- adding conditions on repository or project names;
- creating a project-specific configuration directory in Action Worker;
- running full CI / build / review / release / deploy itself;
- choosing a self-hosted runner itself;
- storing central secrets;
- copying central policies.

If one of these seems necessary, first check whether a generic capability is missing.

## 15. GitHub platform boundary

The unified execution architecture does not mean that every GitHub plan has the same platform enforcement.

On GitHub Free, private repositories of an organization do not support rulesets or protected branches, so the central gate in those repositories is a process constraint on the current plan, not a hard platform gate. Public repositories can still use the managed rulesets where the platform allows.

Differences in platform features must not change the execution contract, and must not become a reason to move heavy execution back into business repositories.

## 16. Migration period

Some repositories still keep old CI / Release / Deploy paths. They are migration debt.

During migration, old paths may only shrink; new repositories and new capabilities use the unified execution contract directly.
