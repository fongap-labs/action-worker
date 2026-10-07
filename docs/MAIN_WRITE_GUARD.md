# Main Write Guard

This document defines the boundary for the origin of writes to the `main` branch of managed repositories.

## 1. Goal

Every managed repository, public or private, follows:

```text
Only a PR that passed deterministic gates
may produce a trusted main SHA.
```

The long-term goal is not to "detect direct pushes" but to make sure a `main` SHA that did not come from a legitimate PR merge can never enter any formal execution chain.

## 2. Two gates

```text
Before main
  validate-merge
  = merge eligibility

After main update
  Main Write Guard
  = main provenance
```

`validate-merge` decides whether a PR may merge. For managed business repositories it is a central commit status published directly by Action Worker and does not depend on business repository GitHub Actions. Action Worker's own self-CI may keep using a check of the same name in this repository.

`Main Write Guard` verifies that the current SHA of `main` really was produced by a PR that passed governance and was merged into `main`.

These two responsibilities cannot be merged and cannot replace each other.

## 3. Legitimate main writes

The Main Write Guard re-verifies against the current facts on GitHub; it never trusts a commit message, caller parameters or local state.

Long-term minimal conditions:

```text
repository is managed
head SHA is immutable
head SHA is associated with a merged PR
PR base is main
PR merge result matches the main update
required deterministic gate was successful for that PR/head
```

The implementation adapts to the merge methods the repository currently allows. For the squash merge that Fongap Labs uses everywhere today, it must verify the real relationship between the merged PR returned by GitHub and the target `main` SHA.

None of the following proves legitimacy on its own:

- the commit message;
- the actor name;
- the branch name;
- workflow inputs;
- a self-reported PR number;
- a self-reported `validate-merge` result.

## 4. Illegitimate main writes

If the Main Write Guard cannot prove that the current `main` SHA comes from a legitimate PR merge, that SHA is marked untrusted.

```text
direct push / unknown write
        ↓
Main Write Guard = failure
        ↓
main SHA = untrusted
        ↓
Release denied
Deploy denied
Publication denied
Privileged task denied
```

In a repository where the GitHub platform cannot prevent a direct push in advance, the workflows still fail closed: an unproven SHA never gains any formal output capability.

Whether an illegitimate write is rolled back automatically is an execution policy and cannot replace this trust decision. Even when an automatic rollback fails, the untrusted SHA still cannot be released or deployed.

## 5. Public and private

### Platform enforcement available

When GitHub rulesets / protected branches are available:

```text
require pull request
+ require central validate-merge status
+ no bypass actor
+ restrict direct main update
```

GitHub rejects the illegitimate path before the write, and the Main Write Guard remains a second provenance check.

### Platform enforcement unavailable

When the current GitHub plan cannot give a private repository equivalent enforced protection:

```text
direct main write may physically occur
→ Main Write Guard must fail
→ resulting SHA is quarantined
→ every privileged downstream path must reject it
```

Differences in platform features must not produce a second governance model.

## 6. Workflow boundary

The security of the Main Write Guard must not depend on whether business repository Actions can run.

The authoritative baseline is the central Main Write Audit in the public `action-worker`, which periodically re-reads the current `main` of every managed repository and verifies provenance independently. Even if a business repository has no Actions minutes, its dispatcher was deleted, or a direct push also changed its workflows, an illegitimate SHA cannot gain trust.

A business repository may keep a very thin `main` push bridge as a real-time shortcut, but it is not a security prerequisite and must never produce a trusted conclusion by itself.

Long-term minimal fields of the optional real-time event:

```text
repository
before_sha
head_sha
event
request_id
```

A caller must not submit:

- a boolean conclusion that "this is a legitimate merge";
- the PR gate result;
- release/deploy authorization;
- secrets;
- any bypass marker.

Action Worker re-queries the GitHub facts and forms the `Main Write Guard` conclusion itself.

The central Main Write Audit discovers repositories dynamically from the managed repository list in `AW_REPOSITORY_POLICY`; project names must not be hard-coded in workflows or scripts. The audit must prove provenance again for every current main SHA and must not skip verification just because a success status of the same name already exists.

## 7. Downstream requirement

These operations require `Main Write Guard = success` bound exactly to the target source SHA:

- Release;
- Deploy;
- Publication;
- production / privileged execution;
- any task that can spread source code into a formal runtime or formal distribution environment.

"The branch is called main" never replaces the Main Write Guard.

## 8. AI Review

AI Review is not part of the Main Write Guard and cannot take part in its conclusion.

The order for a PR is:

```text
Security / CI / PR deterministic gates
        ↓
Action Worker validate-merge / PR Governance PASS
        ├──→ merge authority
        └──→ AI Review (advisory, asynchronous)
```

After the gate passed, AI Review may keep finding problems, making suggestions and posting comments, but it:

- must not change `validate-merge`;
- must not change `PR Governance`;
- must not change the `Main Write Guard`;
- must not grant Release / Deploy permission;
- must not delay or change the deterministic gate through failure, timeout or an unavailable model.

## 9. Permissions

The Main Write Guard itself only needs to read GitHub facts and publish a controlled status.

AI Review must not hold main write, merge, release or deploy permission.

Every credential that can write `main`, publish a release or run a deploy is controlled by an independent deterministic authority.

## 10. Acceptance criteria

The governance loop is complete when:

1. every managed repository uses the same Main Write Guard contract;
2. public repositories also enable the native PR-only protection where the platform allows;
3. in private repositories, even when a direct push physically happens, the illegitimate SHA cannot enter the formal output chain;
4. Release / Deploy verify the Main Write Guard;
5. AI Review runs after the deterministic PR gate and never becomes a gate;
6. no new runner, repository or product can bypass this chain.
