# Private task isolation — production cutover evidence gate

Status: **BLOCKED**. This is an evidence checklist, not an activation procedure. No private pilot, credential provisioning, or production Secrets mutation is authorized by this document. Do not set an activation Variable just because CI is green.

## Current baseline (2026-11-06)

- The merged encrypted publication path uses the existing protected publisher, not a second privileged publisher.
- `policies/private-task-keys.json` currently has `"projects": {}`; there are **zero approved project enrollments**.
- `AW_PRIVATE_ISOLATION_PILOT_ENABLED` defaults off unless explicitly provisioned, and the private source must pass fixed-SHA / exact-group / capability checks.
- `AW_PRIVATE_ISOLATION_LOCK_ATTESTED` is an attestation only. Workflow `concurrency` serializes this workflow's group but cannot protect independent dispatchers, old in-flight workflows, or external artifact writers.
- `AW_PRIVATE_LEGACY_EXECUTION_DISABLED` does not by itself migrate historical state. Until the old private Runner is retired, its legacy `execute` path still requires the private historical artifact key.

## Evidence required before a single project is enabled

All items must be satisfied **for an exact source repository + project** and an approved immutable bootstrap SHA; record run URLs, SHA, the reviewing maintainer and UTC timestamps in a private change record. Never put key material, private task logs or private state in a public PR.

| Gate | Required evidence | Failure consequence |
| --- | --- | --- |
| 1. Source and scope | Repository is private, source SHA pinned, `projects/<project>/.isolated-private-task` exactly declares `stateful-private-v1`, operation is `task`; central task policy admits **zero** business Secrets and Variables | Reject, no legacy fallback for selected pilot |
| 2. Key enrollment | Separately reviewed exact `repository:project` entry with distinct inbound/outbound SHA-256 public-key fingerprints; independently verify the four project-specific public Variable/private Secret roles and actual key pairs in their respective trust domains | Do not set pilot enabled |
| 3. Historical recovery | Run against a copy of the project's **real historic encrypted artifact**. Prove manifest identity, encryption format, state bytes after restore, and next-run restore. Failed tasks must not overwrite the last good state; secrets and task identifiers must not appear in public logs | Halt and retain last good artifact |
| 4. Lifecycle concurrency | Demonstrate serialization across new prepare/run/finalize, legacy executions already running, reruns, queued requests, every independent workflow and **all external state writers**. Capture overlapping-request evidence with no lost updates or canceled pending tasks | Do not attest lock or enable pilot |
| 5. Adversarial Runner isolation | Real runner/container evidence for no network, read-only source, non-root, no host credentials, no Docker socket, no surviving background writer, no symlink/hardlink/path traversal/forged manifest, and strict artifact size/identity handling | Reject, fix implementation before retry |
| 6. Controlled publication | Prove successful task can stage an encrypted bound artifact and the **existing** `admin-ops` publisher alone decrypts after policy/PR/CI guard; failed/unauthorized/mismatched requests publish nothing; verify existing release target compatibility | Do not enable publication for the project |
| 7. Old Runner retirement | Inventory all pending, in-flight and alternative private execution entries. Prove no legacy private task can receive `AW_ARTIFACT_KEY` after cutover; then enable strict legacy rejection, with independent verification against bypass/fallback | Keep strict cutover unapproved |
| 8. Operational rollback | Verify failure response preserves last good state, does not silently fall back to privileged execution, retains audit evidence, and has a tested recovery process without re-exposing the central key | Do not cut over |

## Required sequence and sign-off

1. **Read-only inventory:** enumerate the actual project, legacy state artifact lineage, currently active/queued runs, all writers, publication destinations, and project key enrollment. Missing inventory means blocked.
2. **Isolated rehearsal:** on explicitly approved non-production material, check key-pair identity, historical-format compatibility, malicious task cases, encrypted publication and recovery. CI's synthetic Docker test is necessary but not a substitute for this.
3. **Lock proof:** independently review complete ownership/lease/fencing or equivalent exclusion of every writer; a GitHub boolean or `queue: max` alone is insufficient.
4. **Maintainer review:** two independent reviewers record the evidence and residual risks in a restricted change record. Do not paste Secret values or private artifact contents in that record.
5. **Controlled cutover:** only after all eight gates pass, separately approve the exact project enrollment and minimal configuration changes. Stop on any mismatch; never use an automatic legacy privileged fallback.
6. **Post-cutover verification:** validate first real run, subsequent historical restore, authorized publication, and that the old private Runner cannot execute. Document all run references.
7. **Final removal:** only after evidence shows no remaining legacy users, submit a separate change to remove the old private `execute` credential path, with normal Security / Naming / Static / Contract / Real Docker / `validate-merge` gates intact.

## Explicit prohibitions

- No automatic writes to production Secrets, Variables or Environments.
- No shared transfer private keys or generic `AW_TASK_TRANSFER_*` fallback.
- No use of `AW_ARTIFACT_KEY` in the nonprivileged private task Runner.
- No bypass of CI Evidence, Main Write Guard, publication policy, approval or protected `admin-ops` controls.
- No assertion of production readiness from static checks or synthetic integration tests alone.

**Current decision: NO-GO** because enrollment is empty and real project, writer-coordination, history and production evidence have not been supplied or independently verified.
