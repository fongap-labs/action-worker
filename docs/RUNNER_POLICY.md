# Runner Policy

This document defines the runner abstraction, runner selection and the trust boundaries of Action Worker.

## 1. Runner ownership

Runners belong to the Action Worker execution plane, not to business repositories.

A business repository declares only `runner_profile` and must never name directly:

- a GitHub-hosted runner image;
- a self-hosted label;
- a runner group;
- a particular server, hostname or cloud instance;
- a runner fallback order.

Action Worker resolves the actual runner from the policy.

## 2. Runner profiles

A runner profile expresses an execution need, not an infrastructure instance.

Long-lived generic profiles are recommended, for example:

```text
linux-standard
windows-build
macos-build
arm64-linux
trusted-deploy
```

The concrete set of profiles is managed by the machine policy; a business repository must not create a profile for one repository.

## 3. Backends

Action Worker allows at least two kinds of runner backend:

```text
github-hosted
self-hosted
```

When another compute backend is added in the future, the runner resolver is extended; business repository manifests do not change.

Self-hosted is a formally reserved backend, not an exception path.

## 4. Resolution

```text
runner_profile
  ↓
Runner Policy
  ↓
trust / os / arch / resource / network requirements
  ↓
Runner Resolver
  ↓
actual backend and runner
```

For example:

```text
linux-standard
→ GitHub-hosted Linux

arm64-linux
→ eligible ARM backend

trusted-deploy
→ trusted runner with required private-network access
```

These are semantic examples only and not a fixed implementation mapping.

## 5. Trust domains

Runner selection follows trust domains, not performance alone.

At least these are distinguished:

```text
sandbox
control
privileged
```

### Sandbox

May execute untrusted project code, PR code, builds and tests.

Must not hold:

- central management tokens;
- AI Gateway management credentials;
- production deployment credentials;
- unnecessary cross-repository write access.

### Control

May run governance, planning, evidence processing and controlled API operations.

Must not execute untrusted PR code directly.

### Privileged

Only for controlled operations that really need the production network or production credentials, such as a production deploy.

A privileged task fails closed and never falls back to a lower trust level because the target runner is unavailable.

## 6. Fallback

Runner fallback is decided by the central policy.

Automatic fallback is allowed only between backends with equivalent security properties.

For example:

- an ordinary Linux build without secrets may switch between equivalent compute backends;
- a deploy that needs a private network or production secrets must not fall back automatically to an ordinary GitHub-hosted runner;
- an architecture mismatch must never continue by simulating "success".

## 7. Self-hosted boundary

A self-hosted runner is a replaceable compute resource, not part of the business architecture.

A business repository must not depend on:

- the runner hostname;
- fixed local directories;
- tools that are preinstalled but not declared;
- long-lived workspace state maintained by hand;
- secrets that exist only on one machine.

Self-hosted execution keeps, as far as possible:

```text
ephemeral workspace
explicit dependencies
least privilege
clean checkout
controlled cache
auditable provenance
```

## 8. Secrets

Action Worker decides secret injection from the capability grant and the trust domain.

A business manifest must not name secrets.

A runner receives only the minimal credentials this task needs; after the task, no secret may be written to an artifact, cache, log or project workspace.

## 9. Scheduling boundary

CI, build, review, release, deploy, tasks and scheduled jobs all choose their backend through the same runner resolver.

This must never happen:

```text
CI has one runner selection
Release has a second one
Deploy hard-codes a third one
```

Different operations may state different needs, but the underlying resolution mechanism is one.

## 10. Migration

Workflows that use `runs-on` directly may keep doing so during migration, but in the long term they converge on the central runner policy.

A new business repository must not add a runner policy of its own.

Acceptance criterion:

> Replacing GitHub-hosted runners, adding a self-hosted runner or migrating compute infrastructure requires no change to execution logic in business repositories.

## 11. PR dispatcher runner extension

A business repository may use the approved thinnest PR trigger `templates/pr-dispatcher/dispatch-pr-governance.yml`, so that PR events reach central governance within about a minute. It runs in the control domain, only sends a notification, and neither checks out nor executes any PR code.

Runner selection follows section 1: the workflow file in the business repository contains no runner name or label; `runs-on` reads a centrally managed repository variable:

```text
runs-on: ${{ fromJSON(vars.AW_DISPATCH_RUNS_ON || '"ubuntu-24.04"') }}
```

- Without the variable, GitHub-hosted Linux is used.
- The central policy provides two control-domain profiles: `control-standard` (GitHub-hosted) and `control-self-hosted` (`enabled: false` by default, falling back to `control-standard`).
- The variable value is produced only by `node scripts/resolve-dispatcher-runs-on.ts <profile>`; that script refuses sandbox and privileged profiles.

To enable self-hosted for one repository (it uses your own compute and no GitHub-hosted minutes):

```bash
gh variable set AW_DISPATCH_RUNS_ON --repo fongap-labs/<repo>   --body "$(node scripts/resolve-dispatcher-runs-on.ts control-self-hosted)"
```

Boundaries:

- Use it for private repositories only. Do not register a self-hosted runner for a public repository: a workflow from a fork PR could schedule code onto it.
- When the runner is offline, GitHub does not fall back automatically and the job stays queued; central intake still covers governance, so only speed is affected, not security.
- The file is protected by `approved_workflows` in the security gate: its path and content hash must match the approved template byte for byte, and any change puts it back under the `pull-request-target` rule.
- Dependabot cannot read Actions secrets, so the trigger skips its pull requests and central intake handles them.
