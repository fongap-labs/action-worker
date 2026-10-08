# Development Guide

This document defines the development flow shared by Action Worker and the managed business repositories. Machine boundaries are set by contracts / policies / rules and the governance documents.

## 1. Before you start

Decide first:

1. whether this is a project implementation or a generic governance / execution capability;
2. whether a reusable contract, policy, executor or skill already exists;
3. whether the change moves a trust, secret, runner, gate, release or deploy boundary;
4. whether contract tests and documentation must change with it.

Principle:

> Project implementations stay in the business repository; governance, authorization and heavy execution go into Action Worker.

Public and private repositories follow the same rules.

## 2. Action Worker owns

Action Worker carries: PR Governance, CI / test / build execution, AI Review, CI Evidence, task / scheduled execution, runner resolution, the gate, Source Policy, release build / governance / publish, deploy governance / execution, artifacts / provenance, generic status write-back and the generic input and output contracts.

## 3. Business repository owns

A business repository keeps: product code, project tests, build / package / deploy scripts, project architecture and protocols, the execution manifest, platform-specific toolchain declarations, the thinnest dispatch, and a very thin check bridge where the GitHub platform really needs one.

A business repository must not keep a second central governance, and must not run long-lived heavy CI / build / review / release / deploy for its own convenience.

## 4. Development flow

```text
Inspect
→ Define Contract
→ Implement
→ Test
→ PR
→ Security Gate
→ Central CI
→ Governance / validate-merge
├→ Merge
└→ AI Review (post-gate, advisory)

Merge
→ Main Write Guard
→ trusted main SHA
```

When a boundary changes, change the contract, the policy or the regression tests first, then the implementation.

## 5. CI

Project test code belongs to the business repository; by default it runs in the Action Worker sandbox.

```text
repository event
→ thin dispatch
→ Action Worker
→ checkout immutable source
→ project test / build
→ CI Evidence
```

If the GitHub platform requires the target repository to create a required check, a very thin `validate-merge` bridge may stay. That bridge runs no product tests; it only joins the central `CI Evidence` and `PR Governance`.

## 6. Runner

Project code must not bind to a concrete runner infrastructure. A project declares only `runner_profile`; the Action Worker runner policy resolves the actual GitHub-hosted or self-hosted backend.

Adding a self-hosted runner must not require a change in a business repository. See [RUNNER_POLICY.md](RUNNER_POLICY.md) for the detailed rules.

## 7. Workflow changes

A workflow change checks at least: whether permissions are minimal, whether a secret reaches an untrusted execution domain, whether a trigger can be abused through fork or PR input, whether concurrency is correct, whether the source SHA is immutable, whether the runner is chosen by the central policy, whether artifacts and evidence are bound to the source SHA, plus the deterministic Security Gate, actionlint, contract tests and ShellCheck where needed.

Workflow file names follow the rules in [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) section 7; `tests/workflow-naming.test.ts` checks them.

The Security Gate is independent of AI Review and at least blocks newly added high-confidence credentials, sensitive key files, `toJSON(secrets)`, `pull_request_target`, `permissions: write-all` and external actions that are not pinned to a commit SHA.

Control logic is written in TypeScript first. Shell is only short runner glue or an explicit external bootstrap boundary.

## 8. AI and the gate

AI reviews, suggests and finds problems; it decides neither permission boundaries nor the merge gate. AI Review runs after the deterministic PR gate conclusion, and every AI finding, whatever its severity, is advisory evidence. An AI Review timeout, an unavailable model or a review engine failure can neither change the gate nor delay its conclusion.

The gate trusts only deterministic policy, the Security Gate, CI Evidence, PR Policy, Release / Deploy Policy, current GitHub facts and execution provenance.

An agent must not change the deterministic gate through re-runs, a different model, a different runner or any review parameter.

## 9. Main Write Guard

Every source SHA that enters a formal release or deploy must pass the Main Write Guard first. A branch named `main` is not proof of a trusted origin.

A direct push, an unknown write or a SHA that cannot be linked to a merged PR that passed the gate fails closed.

## 10. Release / Deploy

The business repository owns the project scripts; Action Worker owns central execution, credentials and governance.

```text
Release: immutable source → central build/package → artifact + provenance → Release Governance → publish / verify / rollback
Deploy:  immutable source → central source gate → project deploy script → Runner Resolver → controlled deploy → health verify / rollback
```

## 11. Definition of done

Before finishing a task, confirm that:

- no repository-name or project-name branch was added;
- no heavy execution was added to a business repository;
- no runner infrastructure was written into a project contract;
- there is no second secret / gate / release authority;
- contract tests cover the new boundary;
- the documentation distinguishes the current implementation from the target boundary;
- old entry points were removed or explicitly added to the migration list;
- new or changed documentation can be understood by someone without project background (see [SHARED_GOVERNANCE.md](SHARED_GOVERNANCE.md) section 8).
