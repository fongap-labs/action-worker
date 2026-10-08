# Proposal AW-002: isolate deploy and task secrets with GitHub Environments

Status: **the deploy path is implemented** (PR "let the control plane decide deploy environments and secret ceilings": central environment and secret policies, read-only checkout token, `admin-ops` for admin-token jobs). **The task path stays as it is (option A)**; options B and C remain available after the deploy rehearsal. **Still manual for the owner:** one rehearsal deploy, switching `AW_DEPLOY_SECRET_POLICY_MODE` to `enforce`, then copying secrets into the environments and deleting the repository-level copies.

## What exists today

- `source-script-deploy.yml` job `deploy` already declares `environment: ${{ needs.prepare.outputs.environment }}`, but that value is read from the **target repository's** `deploy.json` (the party being deployed names its own environment). The step that runs target code uses `env: ${{ secrets }}`: every repository-level secret (and the environment's) is placed in the step environment and the names the target did not declare are then `unset`.
- `handle-task-dispatch.yml` (job `execute`) does the same with `env: ${{ secrets }}` and the allow-list from the task source; since PR #410 a central ceiling (`policies/task-secrets.json`, `AW_TASK_SECRET_POLICY_MODE=warn|enforce`) can only reduce what a task source declares. The task job has **no** `environment:`.
- `unset` removes names from the process environment; it does not stop code that already runs in the same job from reading runner memory, and the allow-list is declared by the executed party.
- Environments `production` and `admin-ops` exist in `fongap-labs/action-worker` with a main-only deployment branch policy. Repository-level secrets are still in place.
- In the deploy path the 4th argument of `resolve-secret-scope.ts` (the denied names) is not passed, so only the target-declared allow-list and the built-in reserved prefixes apply.

## What we want

The central repository, not the deployed repository, decides which environment a repo may use and which secret names may reach it; secrets move from repository level to environments, so a job that is not bound to an environment cannot read them at all.

## Design

1. **Environment authority** (`policies/deploy-environments.json`): `{ "<owner/repo>": ["production", ...] }`. `validate-deploy-source.ts` checks, after parsing the manifest, that the declared `environment` is in the set for that repository; otherwise the deploy fails closed. A repository that is missing from the file cannot deploy.
2. **Central secret list** (`policies/deploy-secrets.json`): `{ "<owner/repo>": { "<environment>": ["NAME", ...] } }`. The effective allow-list is the **intersection** of the target's `deploy.secrets.allowed` and this list; a target name outside the central list fails (not silently dropped), as the task ceiling does in `enforce` mode. Reserved prefixes stay rejected (`AW_`, `GITHUB_`, `RUNNER_`, `ACTIONS_`, `NODE_OPTIONS`, `GH_TOKEN`) and are passed as the 4th (denied) argument.
3. **Branch restriction**: environments keep the deployment branch policy "main only". The deploy job runs on this repository's `main` (the workflow is dispatched by `repository_dispatch`, which always uses the default branch), so a PR branch cannot obtain environment secrets. No workflow change is needed for this beyond verifying it in the rehearsal below.
4. **Checkout token**: `Checkout deploy source` stops using `AW_CONTROL_TOKEN`. It uses the read-only `AW_CHECKOUT_TOKEN` (already introduced for the CI jobs in PR #411) or `github.token` when the target is public. The invariant test from PR #411 is extended so the `deploy` job may not reference `AW_CONTROL_TOKEN` or `AW_ADMIN_TOKEN`.
5. **Admin-token jobs**: every job that uses `AW_ADMIN_TOKEN` must also declare `environment: admin-ops`; otherwise moving that secret into the environment breaks it. This is a gap in the original plan. The affected workflow list is produced by a test that fails when a job references `secrets.AW_ADMIN_TOKEN` without `environment:`.
6. **Task path** (`handle-task-dispatch.yml`) — three choices:
   - A. Only the deploy path now; keep repository-level secrets for tasks, enforce the central ceiling. Lowest risk, keeps the main weakness for tasks.
   - B. Add `environment: tasks-<repo>` per task source repository. A job's `environment:` can be an expression, so one job can serve all repositories, but every repository needs its own environment with its own copy of the secrets; per-project secrets (e.g. different projects of one repository) cannot be separated by environments, only by the central ceiling.
   - C. B for repositories with real secrets (ai-gateway, internal-vault) and A for the rest.
   - **Recommendation: A now, B/C after the deploy rehearsal succeeds.** Task secrets cannot be removed from repository level until the consumers declare environments.
7. **Transition and rollback**: repository-level secrets stay until the rehearsal passes. Rollback is reverting the PR; the old behaviour remains available as long as the repository-level secrets exist.

## Impact and risks

- Every deploy of ai-gateway (37 names, environment `production`) and internal-vault (3 names, `server-edge-cloud-edge`) depends on the two new policy files being complete; a missing name fails the deploy, intentionally.
- GitHub Free: environment secrets and deployment branch policies are available for public repositories; whether private repositories on the Free plan can use environment protection rules is **not verified** (documentation could not be fetched in this session). The deploy environments live in the public `action-worker` repository, so this is not a blocker, but required reviewers on a private repository would be.
- `repository_dispatch` jobs always run on the default branch, so "main only" is satisfied by construction; the policy still guards manual `workflow_dispatch` runs from other branches.

## Plan constraints (owner, 2026-10-07)

The organization stays on the Free plan and the private repositories stay private. This design is unaffected: the environments (`production`, `admin-ops`, and any `tasks-<repo>`) belong to the **public** `action-worker` repository, where environment secrets and the main-only deployment branch policy are available on Free. The private repositories only appear as deploy and task *sources*; nothing is configured in them.

## Owner steps (manual)

1. Approve or amend this design (especially item 6).
2. After implementation merges: create the same-named secrets in the environments (P-00 C2), run one `workflow_dispatch` deploy of ai-gateway as a health-check rehearsal, and only then delete the repository-level copies (P-00 C3). I will not delete any secret.
3. Confirm `AW_CHECKOUT_TOKEN` is read-only (Contents: read) for all target repositories.

## Implementation plan after approval (phase 2)

New policy files and validators with tests; `validate-deploy-source.ts` environment check; wire the denied-names argument; swap the checkout token; extend the invariant tests; docs and CHANGELOG. Acceptance: `npm run check`, new tests for "unauthorised environment fails" and "target declares more than the central list fails".
