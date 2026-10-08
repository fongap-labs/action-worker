# Repository Governance

Action Worker keeps the shareable repository defaults and the merge governance boundary for the managed Fongap Labs repositories.

## 1. Machine authority

The unified Repository Policy lives in:

```text
policies/repository.json
```

Current defaults:

```text
Issues                  ON
Projects                OFF
Wiki                    OFF
Discussions             OFF

Merge commits           OFF
Squash merging          ON
Rebase merging          OFF
Auto-merge              OFF
Update PR branches      ON
Delete head branches    ON

Web commit sign-off     OFF
Squash title            PR title
Squash message          Blank
```

Repository names do not enter the policy; it describes only the shared settings.

## 2. Application

`policies/repository.json` is the only shared authority for the Repository Settings of managed repositories.

Action Worker applies it in two ways:

```text
push to main
  repository policy / apply workflow changed
  → apply to Action Worker itself
  → apply to every repository with the pr capability in AW_REPOSITORY_POLICY

manual workflow_dispatch
  → apply one repository
  → dry-run by default
```

Manual inputs:

```text
repository = owner/name
is_dry_run = true | false
```

Both the automatic sync and manual writes use the separate `AW_ADMIN_TOKEN`, never `AW_CONTROL_TOKEN`. The script applies the settings idempotently and verifies what GitHub returns.

A managed repository must not keep settings that differ from the central Repository Policy for long. A project-level exception first needs an explicit governance reason, and then either a change to the shared rules or a recorded exception boundary.

## 3. Merge authority

The shared governance target is:

```text
Security Gate ───────────┐
Central CI Evidence ─────┤
PR deterministic policy ─┼→ validate-merge → merge
                         │
                         └→ AI Review after gate (advisory only)
```

`validate-merge` is the only merge authority. Action Worker publishes it directly to the current PR head after the deterministic Security, CI Evidence and PR Policy checks all passed; AI Review is not one of its inputs and must not change its result.

Business repositories no longer create a `validate-merge` check. The ruleset of a public repository requires the central `validate-merge` status directly; private repositories on the Free plan have no equivalent hard platform gate, but the Main Write Guard still requires the same central status, so both kinds of repositories use the same governance facts.

A local `cancel-pr-work` in a business repository when a PR closes is only a real-time shortcut of the migration period; central intake / reconciliation must make sure the central control plane still recognises and settles stale work when business repository Actions are unavailable.

## 4. GitHub native enforcement

The Repository Policy and GitHub's native protection are two layers:

```text
Repository Policy
├─ feature switches
├─ merge methods
└─ branch cleanup

GitHub native protection
├─ require pull request
├─ require status checks
├─ protect main
└─ restrict bypass
```

The repository rulesets of public managed repositories are managed centrally by Action Worker; the authoritative file is `policies/rulesets.json`. It currently manages `Protect Main Branch` and `Protect Legacy Branches`; no second rule definition may be maintained by hand in a business repository. Repository settings and rulesets are both applied by `apply-repository-settings.yml` with `AW_ADMIN_TOKEN`.

Native ruleset / branch protection depends on the GitHub plan available to the repository and on the connection permissions. A GitHub Free organization gets rulesets and protected branches only for public repositories; for private repositories this is a platform limit, and documentation, audits and automation must never claim that they have the same enforced `main` protection as public ones. Private repositories still go through the central PR Governance / CI Evidence / validate-merge flow; the GitHub platform may lack enforcement before the write for now, but the Main Write Guard quarantines, after the write, any main SHA that lacks the central merge authority.

The central `validate-merge` contract stays the same in every managed repository; native platform protection is only an extra enforcement layer where it is available.

## 5. Main Write Guard

Every update of `main` in a managed repository goes into the one Main Write Guard. Its job is not to repeat the PR gate but to verify that the origin of the current `main` SHA is legitimate.

```text
validate-merge
→ PR merged
→ main updated
→ Main Write Guard
→ trusted main SHA
```

The Main Write Guard proves again from the current facts on GitHub that the target SHA comes from a PR merged into `main` and that this PR/head passed the required deterministic gate. It never trusts a commit message, an actor, a self-reported PR number or a gate conclusion supplied by the caller.

If a legitimate origin cannot be proven:

```text
Main Write Guard = failure
→ source SHA = untrusted
→ Release denied
→ Deploy denied
→ Publication denied
→ privileged execution denied
```

Where GitHub native protection is available, a public repository also relies on the ruleset to reject a direct push before the write; in a private Free repository, even when the platform allows a direct push, the Main Write Guard quarantines that SHA and keeps it out of the formal output chain.

See [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md) for the detailed rules.

## 6. Change rule

When a shared default changes, change together:

```text
policies/repository.json
→ governance tests
→ this document
```

A repository exception specific to one project needs an explicit reason and must not be copied into a second generic policy.
