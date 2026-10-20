---
name: deploy-verify
description: Verify deploy source identity, Main Write Guard, environment gates, health checks, and rollback readiness before and after deployment.
domain: coding
operations: [deploy]
---

# Deploy Verify

Use before or after executing a deployment.

This skill mirrors `release-verify` for the deploy lifecycle. `change-impact` analyzes the blast radius; this skill verifies the deployment itself.

## 1. Verify source identity

Confirm:

- source repository;
- immutable source SHA;
- Main Write Guard success result bound to that SHA;
- required CI evidence for that SHA.

A SHA merely on `main` is not sufficient. Only a Main Write Guard result bound to the exact SHA authorizes deployment. See `07_MAIN_WRITE_GUARD.md`.

## 2. Verify deploy manifest and environment

Validate:

- deploy manifest (`.github/deploy.json` or equivalent) matches the expected environment;
- environment name, product, and trigger are consistent with the dispatch request;
- the manifest does not declare secrets, runner labels, or bypass switches;
- environment promotion order is respected (e.g., staging before production).

## 3. Verify project deploy script execution

Confirm:

- the project deploy script ran against the immutable source SHA;
- the script exited with the expected status;
- no unexpected side effects occurred outside the declared environment.

## 4. Verify health checks

After the deploy script completes:

- run the project's declared health check;
- confirm the service responds on the expected endpoint;
- confirm no error-rate spike beyond the project threshold;
- if the project declares no health check, record that as a finding.

A successful deploy script exit is not sufficient evidence of a healthy deployment.

## 5. Verify rollback readiness

Before declaring the deploy complete:

- confirm the rollback path exists and is known;
- confirm the previous version artifact or commit is reachable;
- confirm the rollback script or procedure is documented and executable.

If rollback is not possible, record it as a risk before declaring success.

## 6. Failure handling

If a deploy partially created state:

- follow the project's rollback contract;
- trigger rollback before declaring failure;
- do not leave a half-deployed state in production;
- record the failure layer (source, script, runner, network, environment).

## 7. Cross-repository deployment

When source and deployment target differ:

- verify both sides of the contract;
- the source repository provides the immutable SHA and deploy manifest;
- the deployment target receives the deploy only after source verification passes;
- the deployment target does not become the source of deploy logic.

## 8. Completion

The deploy is verified when:

- source SHA has a Main Write Guard success result;
- deploy manifest and environment match the dispatch request;
- project deploy script executed successfully;
- health checks pass;
- rollback readiness is confirmed or recorded as a risk;
- no half-deployed state remains.
