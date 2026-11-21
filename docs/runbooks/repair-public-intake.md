# Public repair ledger admission pilot

This pilot is deliberately restricted to `fongap-labs/action-worker`. It does not
admit or publish private repository identities or source data.

## Trusted entry point

The manually dispatched
`.github/workflows/repair-public-intake.yml` runs only on control
`main` and checks its exact `GITHUB_WORKFLOW_REF`. It accepts **no source
repository field**, Issue body as shell code, or user-provided execution command.

An operator provides:

- An existing **open action-worker Issue number** (not a PR).
- A **completed failed or timed-out** action-worker Actions run ID and its exact HEAD SHA.
- A 64-hex **tentative normalized root-cause identity**. This is not a diagnosis attestation.

The trusted script re-reads repository metadata, the failed Actions run, and
the open Issue from GitHub using a read-only, repository-scoped App token. A
separate contents-write token is scoped to **action-worker only** to create
one durable opaque repair-ledger Git ref. Competing writes are handled through
create-once/re-read behavior; an existing root identity returns its original
Issue and task rather than duplicating work.

Only the `discovered` stage is persisted. Root cause evidence is initially
null. No PR is generated, source code is executed, or CI status is forged.

## Privacy and deployment boundary

Never enter private repository names, private log excerpts, credential
material, or private source paths in this public workflow's inputs.
Private intake requires a separate source-owned isolation design and real
private end-to-end tests; this pilot is not a workaround.

The workflow does not run automatically from every failed build. Scheduled
discovery remains read-only until candidate-to-Issue binding and authenticated
root-cause evidence are implemented. This pilot does not authorize release,
deployment, permission changes, or merging high-risk remediation.
