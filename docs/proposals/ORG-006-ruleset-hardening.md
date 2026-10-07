# Proposal ORG-006: harden the main-branch ruleset

Status: **phase 1 adopted** (strict status checks on the four public repositories; PR "require pull requests to be up to date before merging"). Phase 2 (one approval and a bypass actor) and phase 3 (GitHub App) are not started and need the owner's decision.

## 现状

`policies/rulesets.json` defines "Protect Main Branch" for every managed repository: no deletion, no non-fast-forward, linear history, squash merge only, review threads resolved, and a required status check `validate-merge`. Specifics that matter here:

- `required_approving_review_count: 0`, `require_code_owner_review: false`, `require_last_push_approval: false`, `dismiss_stale_reviews_on_push: false`.
- `strict_required_status_checks_policy: false` (a branch need not be up to date before merging).
- The required check is matched by name (`context: "validate-merge"`) without an `integration_id`, so any actor that can create a commit status with that name satisfies it.
- `bypass_actors: []`.
- The file is applied to all managed repositories by `apply-repo-settings.yml` as soon as a change to `policies/rulesets.json` reaches `main` of this repository. One merge therefore changes every managed repository.
- `scripts/apply-repo-settings.ts` skips rulesets for private repositories "under the current GitHub Free organization". Checked on 2026-10-07 against the API: for `internal-vault`, `delta-suite` and `app-source`, both the rulesets and the branch protection endpoints answer 403 "Upgrade to GitHub Pro or make this repository public". **Decision (owner, 2026-10-07): the organization stays on the Free plan and the private repositories stay private.** So these three repositories can never have a branch ruleset, and this proposal applies to the four public ones only (`action-worker`, `ai-gateway`, `delta`, `external-vault`).
- The organization has two people (`fongap`, `fongxen`).

## 选项 (each independent)

1. **Required approvals = 1.** Every PR needs one approval from someone other than the author (GitHub does not let an author approve their own PR). With two people this means every PR from one of them needs the other. Dependabot PRs and automation PRs (work-metrics, bot commits) also need a human approval. Risk: if one person is away, nothing merges, and there is no bypass actor to fall back on (`bypass_actors: []`).
2. **CODEOWNERS approval for control paths.** Turn on `require_code_owner_review` and use the `CODEOWNERS` files (action-worker already has one; ai-gateway, app-source, external-vault, internal-vault get theirs in the ORG-009 PRs). GitHub's rule is per repository, not per path: with it on, **every** file covered by a CODEOWNERS rule needs an owner's approval, and the `*` rule covers everything. To restrict it to `.github/workflows/**`, `policies/**`, `scripts/**`, `contracts/**` the global `*` line would have to be removed from CODEOWNERS, which leaves other paths unreviewed by owners. It is equivalent to option 1 plus naming who may approve.
3. **Strict status checks.** `strict_required_status_checks_policy: true` forces the branch to be up to date with `main` before merging, which makes `validate-merge` run on the merge result. Cost: with the sequential merges in this organization, every open PR must be updated after each merge (Dependabot's "rebase" and `allow_update_branch` help; mine are many stacked PRs).
4. **Bind `validate-merge` to the publishing app (`integration_id`).** Required checks can name the GitHub App that must have produced them, but only for checks (Checks API), not for plain commit statuses. `validate-merge` is published as a commit status by a token today. Binding means moving to a GitHub App that creates check runs, or at least to a dedicated App identity; that is new infrastructure (App registration, key storage as a secret, rotation). Until then, anyone with write access and a token can post a status with that name.
5. **Add `fongap` as a bypass actor** (not asked for, listed because options 1 to 3 make it necessary as an emergency path). Bypass should be limited to "pull request only" mode, not "always".

## 推荐 (phased)

1. **Private repositories (decided, nothing to configure):** the compensating control is the Main Write Guard, which already covers all seven repositories. `main-write-audit.yml` re-checks every managed `main` every five minutes; a `main` SHA that cannot be traced to a merged PR that passed the deterministic gate gets `Main Write Guard = failure` and is untrusted, so release, deploy, publication and privileged tasks refuse it (fail closed). On 2026-10-07 the status was `success` on `main` of all seven repositories. Residual risk, stated plainly: a direct push to `main` of a private repository cannot be prevented, only detected within about five minutes and denied any official output. Keep write access limited to the two maintainers and keep the audit workflow healthy; a failing or stale `Main Write Guard` status is the alarm.
2. **Phase 1:** option 3 (strict) for the repositories where PR volume is low, then watch for a week. Do it via a per-repository override rather than the shared file, if overrides are added; otherwise it applies to all.
3. **Phase 2:** option 1 once there is a second reviewer routine (and option 5 as an emergency path). Not before: with two people and many automated PRs it blocks work.
4. **Phase 3:** option 4 only if a GitHub App is introduced for other reasons (it also helps AW-002/AW-007).
5. Option 2 is not worth it separately; use option 1.
6. Every ruleset change above affects the four public repositories only.

Rollback for each phase: revert the change in `policies/rulesets.json`; the next apply run restores the previous rules.

## 影响与风险

- Because one merge changes every managed repository, trial it first with `apply-repo-settings.yml` run manually in dry-run mode (`is_dry_run: true`) for a single repository.
- A mistake that makes a ruleset unsatisfiable (e.g. approvals required but nobody can approve) blocks merges everywhere, including the PR that would fix it, unless a bypass actor exists. Add the bypass actor in the same PR as any approval requirement, and apply approvals to one repository first.
- Unverified in this session (GitHub documentation was not reachable): whether `integration_id` can match a commit status context (I believe it applies to check runs only). The free-plan limit for private repositories is no longer open: it was confirmed with the API responses quoted above.

## Owner decisions needed

1. Which phases, and whether you accept that every PR needs the other person's approval (phase 2).
2. (Settled) Private repositories stay on the Main Write Guard; no ruleset is possible on the Free plan.
3. Whether to introduce a GitHub App.
