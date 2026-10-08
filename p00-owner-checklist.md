# P-00: manual operations checklist for the fongap-labs organization (generated only, not executed)

> Nature: this file only lists commands, prerequisites, rollback and verification. **No command was executed and no secret was read.** The owner runs every step by hand in their own terminal or in the GitHub UI.
> Related: review report items ORG-001/002/003/004/005/009/011, AW-002/AW-003.
> Commands are bash by default (Git Bash works). GitHub CLI needs `gh auth login` first, with an organization owner account that has the `admin:org` and `repo` scopes.

## 0. Read first: 5 issues found while checking that you need to know

| # | Issue | Impact | Handling |
|---|---|---|---|
| 1 | **The P-AW-3 prompt covers only the deploy and task paths and does not add `environment: admin-ops` to the jobs that consume `AW_ADMIN_TOKEN`** (such as the publish job of `security-scan-dispatch` and `apply-repository-settings`). | If the repository-level `AW_ADMIN_TOKEN` is deleted in C3, those jobs cannot get the token and fail. | In the phase 1 plan of P-AW-3, require the agent to list every job that consumes `AW_ADMIN_TOKEN` and add `environment: admin-ops`; do C3 for this secret last. |
| 2 | The secrets used by the task path (handle-task-dispatch) — CLOUDFLARE_*, ALGOLIA_*, AIG_ACCESS_KEY_TASK, TUSHARE/TIINGO/FRED/ALPHAVANTAGE and others — are injected as a whole with `env: ${{ secrets }}`, so **their consumers cannot be listed by grepping for the name**. A job can also declare only one `environment`. | Putting these secrets only into `production` and deleting the repository-level copies would break the task jobs. | Before deleting any repository-level secret, confirm that every job that consumes it declares the matching environment. Item (e) of P-AW-3 phase 1 must decide whether the task path gets per-repository environments; until that is decided, **do not run C3 for secrets the task path uses**. |
| 3 | The original verification "read `${#AW_ADMIN_TOKEN}` on a new test branch; the length should be 0" is **meaningless** right after C1/C2, because the repository-level secret still exists and the length will not be 0. | It gives a misleading result. | This checklist moves that verification after C3 and adds a second check: "a job that declares the environment but runs on a branch other than main must be refused". |
| 4 | The environments must be created in the **action-worker repository** (where the deploy workflows run), not in internal-vault. The last sentence of the original C1 was easy to read as "create the environment in internal-vault". | An environment in the wrong repository gives no protection. | This checklist states it explicitly: every environment is created in `fongap-labs/action-worker`. |
| 5 | Reducing a GitHub App's permissions is done **by the App's owner on the App registration page**; the installing side (the organization) can only uninstall, suspend or limit the repository scope. | If the App belongs to a third party, its permissions cannot be removed. | Step A handles "own App" and "third-party App" separately. |

There are also 3 API details I **could not check against the official documentation online** (the documentation lookup tool was unavailable in that session). Before running them, confirm them read-first; do not write directly:

- Whether `sha_pinning_required` is a valid parameter of `PUT /repos/{o}/{r}/actions/permissions` (step F). Before running it, check whether the response of `gh api repos/fongap-labs/ai-gateway/actions/permissions` already contains that field; if it does not, check the official documentation under *REST API → Actions → Permissions*.
- Whether `PUT .../environments/{name}` resets fields that are not sent (`reviewers`, `wait_timer`): for an **existing** environment (such as `production`), `GET` and save its current state first, then write the existing values back together with the change (step C1).
- Whether environment protection rules are available for private repositories on the Free plan: this checklist creates environments only in **action-worker (a public repository)**, which avoids the question.

---

## Recommended order

```
D (5 minutes, enable only) → A (inspect + reduce) → B (create a read-only token) → C1 → C2
       → merge P-AW-1 / P-AW-2 / P-AW-3 and rehearse successfully → C3 (one secret at a time)
E / F (organization defaults + platform pinning) can run in parallel; G is a decision; H is a review.
```

Estimated time: D 5 minutes; A 20–40 minutes; B 10 minutes; C1+C2 30–60 minutes (depending on the number of secrets); E 15 minutes; F pilot 30 minutes; G decision; H 30 minutes.

---

## Step D (ORG-009, now): enable private vulnerability reporting

- **Purpose**: give outside researchers a private reporting channel so they do not have to open a public issue.
- **Prerequisite**: **public** repositories only (private repositories do not support it). The 4 public repositories today: delta, action-worker, external-vault, ai-gateway.
- **Command (bash)**:
  ```bash
  for r in delta action-worker external-vault ai-gateway; do
    gh api -X PUT "repos/fongap-labs/$r/private-vulnerability-reporting"
  done
  ```
  PowerShell:
  ```powershell
  foreach ($r in 'delta','action-worker','external-vault','ai-gateway') {
    gh api -X PUT "repos/fongap-labs/$r/private-vulnerability-reporting"
  }
  ```
- **Rollback**: replace `-X PUT` with `-X DELETE`.
- **Verification**:
  ```bash
  for r in delta action-worker external-vault ai-gateway; do
    echo -n "$r: "; gh api "repos/fongap-labs/$r/private-vulnerability-reporting" --jq .enabled
  done
  ```
  All four lines should be `true`.

---

## Step A (ORG-003, now): inspect and reduce GitHub Apps

- **Purpose**: two GitHub Apps have overly broad permissions; look first, then reduce.
- **Prerequisite**: organization owner.
- **Step 1 · inventory**
  ```bash
  gh api orgs/fongap-labs/installations \
    --jq '.installations[] | {id, app_slug, repository_selection, permissions}'
  ```
- **Step 2 · check the repository scope (UI only)**: Organization Settings → GitHub Apps → Installed GitHub Apps → click Configure for each App and note its "Repository access".
  - REST has no endpoint that lets an organization owner list all repositories of an installation directly (it needs an App user token), so this step uses the UI.
- **Step 3 · act**
  - **An unused App**: Configure → Danger zone → Uninstall (or Suspend first and watch for a week).
  - **Your own App** (you own the App): Settings → Developer settings → GitHub Apps → Edit → *Permissions & events*, remove `workflows`, `secrets`, `organization_secrets` (and `administration` if it is not needed). **Reducing** permissions takes effect immediately and needs no new approval.
  - **A third-party App**: its permissions cannot be changed; narrow "Repository access" to Only select repositories, **excluding action-worker, internal-vault and app-source**; uninstall it if that is still not acceptable.
- **Rollback**: for your own App, tick the permissions again on the registration page; the organization side must approve the upgrade request again. An uninstalled App can be installed again.
- **Verification**: run the command of step 1 again; `permissions` no longer contains `workflows`, `secrets` or `organization_secrets`, and the repository scope in the UI is as expected.

---

## Step B (prerequisite for AW-003): create the read-only token `AW_CHECKOUT_TOKEN`

- **Purpose**: the central CI sandbox and the dependency repair compute job stop using the high-privilege `AW_CONTROL_TOKEN` when they check out private repositories.
- **Prerequisite**: the private repositories today are internal-vault, delta-suite and app-source (private = the three that do not support private vulnerability reporting).
- **Create it (UI, by the owner personally)**: GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token.
  - Resource owner: `fongap-labs` (if the organization requires approval, approve it under organization Settings → Personal access tokens)
  - Repository access: Only select repositories → delta-suite, internal-vault, app-source
  - Permissions: Repository → **Contents: Read-only** (Metadata is read-only automatically). Everything else: No access.
  - Expiration: as short as practical (≤ 90 days recommended), and put the rotation in your calendar.
  - A better long-term option: a dedicated GitHub App installation token (see review report XR-003); this step uses a PAT as a stopgap.
- **Store the secret (the owner types it in the terminal; never paste the value to an agent or a chat window)**
  ```bash
  gh secret set AW_CHECKOUT_TOKEN --repo fongap-labs/action-worker
  ```
  The command prompts for the value; paste it and press Enter.
- **Rollback**: `gh secret delete AW_CHECKOUT_TOKEN --repo fongap-labs/action-worker`, and revoke the PAT on GitHub.
- **Verification**
  ```bash
  gh secret list --repo fongap-labs/action-worker | grep AW_CHECKOUT_TOKEN
  ```
  Seeing the name and the update time is enough (not seeing the value is normal).
- **Note**: do not merge P-AW-2 before this name exists.

---

## Step C (ORG-002 / AW-002): isolate production secrets with environments — the order cannot be changed

> Every environment is created in **`fongap-labs/action-worker`**.

### C0 · read the current state first (so existing settings are not overwritten)
```bash
gh api repos/fongap-labs/action-worker/environments --jq '.environments[] | {name, protection_rules, deployment_branch_policy}'
gh secret list --repo fongap-labs/action-worker
```
Save the output as the basis for rollback. If `production` already has reviewers / wait_timer, write them back in C1.

### C1 · create protected environments (deployable only from main)
Environments to create: `admin-ops`, `production`, and `server-edge-cloud-edge`, which the `deploy.json` of internal-vault refers to.

```bash
for env in admin-ops production server-edge-cloud-edge; do
  gh api -X PUT "repos/fongap-labs/action-worker/environments/$env" \
    -F 'deployment_branch_policy[protected_branches]=false' \
    -F 'deployment_branch_policy[custom_branch_policies]=true'
  gh api -X POST "repos/fongap-labs/action-worker/environments/$env/deployment-branch-policies" \
    -f name=main -f type=branch
done
```
- For an existing environment with reviewers, add `-F wait_timer=…` and `reviewers` from the C0 output before running it; never send a bare PUT.
- **Rollback**: `gh api -X DELETE repos/fongap-labs/action-worker/environments/<name>` (this also deletes the secrets inside the environment, so do not roll back to this step casually after C2).
- **Verification**: `gh api repos/fongap-labs/action-worker/environments/<name>/deployment-branch-policies --jq '.branch_policies[].name'` returns `main`.

### C2 · copy the secrets into the environments (the owner types each value; keep the repository-level copies for now)
| Secret | Target environment |
|---|---|
| `AW_ADMIN_TOKEN` | `admin-ops` |
| `CLOUDFLARE_API_TOKEN` (**the ai-gateway Cloudflare account**, see "Two Cloudflare accounts" below), `AIG_ACCESS_KEY_*`, `AIG_TIER*_CREDENTIALS_*`, `AIG_TOKEN_ENCRYPTION_KEY`, `ALGOLIA_*` | `production` |
| the 3 names the internal-vault deploy needs (see its `deploy.secrets.allowed`) | `server-edge-cloud-edge` |

```bash
gh secret set <NAME> --repo fongap-labs/action-worker --env <ENV>
```
- Type the value only at the terminal prompt.
- **Rollback**: `gh secret delete <NAME> --repo fongap-labs/action-worker --env <ENV>`.
- **Verification**: `gh secret list --repo fongap-labs/action-worker --env <ENV>`.
- ⚠ Secrets used by the task path (CLOUDFLARE_ACCOUNT_ID, TUSHARE/TIINGO/FRED/ALPHAVANTAGE and others) are **not migrated yet**; see section 0, item 2.

#### Two Cloudflare accounts share the name `CLOUDFLARE_API_TOKEN`

Two different Cloudflare accounts use this one secret name, and a name can hold only one value per level:

| Level | Holds the token of | Used by |
|---|---|---|
| environment `production` | the ai-gateway account | the ai-gateway deploy (its job is bound to `production`) |
| repository (action-worker) | the account of FongapBlog and FongapCDN | internal-vault tasks (a task job is bound to no environment) |

GitHub gives a job the environment secret in place of a repository secret of the same name, so both work side by side without renaming anything. Consequences:

- Set the environment copy first (`gh secret set CLOUDFLARE_API_TOKEN --repo fongap-labs/action-worker --env production`), and type the **ai-gateway account's** token. Never paste a note or a description into the prompt: a stray non-ASCII character makes Wrangler refuse the token (the deploys of 2026-10-07).
- **Never run C3 for `CLOUDFLARE_API_TOKEN`.** The repository-level copy belongs to the tasks and is not a leftover; deleting it breaks FongapBlog and FongapCDN.
- Replacing the repository-level value changes the tasks only; replacing the environment value changes the ai-gateway deploy only. If a deploy and a task fail at the same time after one secret change, the two accounts were mixed up.

### C3 · delete repository-level secrets (one at a time, and only after P-AW-3 is merged and rehearsed successfully)
**Checklist before deleting (go through it for every secret):**
1. Every job that consumes the secret declares the matching `environment:`.
   ```bash
   # in a local clone of action-worker
   grep -rn "<NAME>" .github/workflows
   grep -rn "secrets }}" .github/workflows   # places that inject all secrets; the environment of these jobs must be confirmed
   ```
2. A deploy has been rehearsed once through `workflow_dispatch` or a dry-run path and succeeded.
3. Every job that consumes `AW_ADMIN_TOKEN` (the publish job of `security-scan-dispatch`, `apply-repository-settings` and so on) declares `environment: admin-ops`.

```bash
gh secret delete <NAME> --repo fongap-labs/action-worker
```
- **Rollback**: `gh secret set <NAME> --repo fongap-labs/action-worker` again (the value has to be typed again).
- **Verification (only after C3)**
  - Test 1: on a new branch, commit a temporary workflow that **declares no environment** and only runs `echo ${#AW_ADMIN_TOKEN}` (prints the length, not the value), triggered by `push`; the length should be `0`.
  - Test 2: on the same branch, commit a workflow that declares `environment: admin-ops`; the job should be refused (the branch is not allowed to deploy to the environment).
  - Delete the test branch afterwards.

---

## Step E (ORG-004): organization default security settings

- **Purpose**: new repositories get basic security features by default.
- **UI path**: Organization Settings → Code security (or *Code security and analysis*) → turn on by default for new repositories: Dependency graph, Dependabot alerts, Dependabot security updates, Secret scanning, Push protection; Settings → Member privileges → turn off Pages creation; Settings → Member privileges / Admin repository permissions → untick "Allow repository administrators to invite outside collaborators".
- **Rollback**: switch the same toggles back in the UI.
- **Verification**: create a temporary test repository, check under Settings → Code security that the defaults are on, then delete the test repository.
- Note: for existing repositories, the same page offers "Enable all".
- **Adjusted for "Free organization, private repositories stay private"**: Secret scanning / Push protection for private repositories are paid features; turning them on has no effect, so do not count them as a control. The alternative for private repositories: the central security gate (`policies/security.json`, which already covers OpenAI/Anthropic, NVIDIA, Hugging Face, Tailscale, Cloudflare, JWT and other formats) checks the lines every PR adds, and the CI of internal-vault also runs a pinned gitleaks. Dependabot alerts and Dependabot version updates are available for private repositories (configured for app-source, delta-suite and internal-vault in this round).

---

## Step F (ORG-005): enforce pinned SHAs at the platform level (pilot in 1 repository first)

- **Purpose**: even if someone writes a floating tag in a workflow, the platform refuses to run it.
- **Prerequisite**: confirm that `sha_pinning_required` is a valid parameter (see section 0); pilot in `ai-gateway` first.
- **Step 1 · list the actions the repository really uses (in a local clone)**
  ```bash
  grep -rhoE "uses: [^@ ]+" .github | sort -u
  ```
  All of `actions/*`, `github/codeql-action`, `astral-sh/setup-uv`, `anchore/sbom-action` and so on must be allowed. Also check **reusable workflows** (`uses: fongap-labs/action-worker/.github/workflows/...@<ref>`): with SHA pinning on, they must be referenced by full SHA as well.
- **Step 2 · read the current state first**
  ```bash
  gh api repos/fongap-labs/ai-gateway/actions/permissions
  gh api repos/fongap-labs/ai-gateway/actions/permissions/selected-actions
  ```
- **Step 3 · write (the allow list first, then turn on pinning)**
  ```bash
  gh api -X PUT repos/fongap-labs/ai-gateway/actions/permissions/selected-actions \
    -F github_owned_allowed=true -F verified_allowed=false \
    -f 'patterns_allowed[]=astral-sh/setup-uv@*' -f 'patterns_allowed[]=anchore/sbom-action@*'
    # …complete it from the list of step 1
  gh api -X PUT repos/fongap-labs/ai-gateway/actions/permissions \
    -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
  ```
- **Rollback**: set `sha_pinning_required=false` and `allowed_actions=all`.
- **Verification**: run the repository's CI once more; it should pass. Then temporarily commit a workflow that uses a floating `@v4` tag; it should be refused. Roll out to the other repositories only after that.
- **Risk**: forgetting to allow any action makes CI fail; that is why it starts with a pilot.

---

## Step G (ORG-001): paid plan decision — decided, nothing to do

- **Decision (2026-10-07, owner)**: fongap-labs stays a **Free** organization, and the existing private repositories **stay private long-term**. So there is **no upgrade and no action that would "give private repositories branch protection"**.
- **Facts verified through the API**: for internal-vault, delta-suite and app-source, the ruleset and branch protection endpoints both return 403 "Upgrade to GitHub Pro or make this repository public". These three repositories will never have branch rules.
- **Compensating control**: the Main Write Guard (`main-write-audit.yml` checks `main` of every managed repository every 5 minutes). A `main` commit that cannot be traced to "a merged PR that passed the deterministic gate" is marked untrusted, and releases, deploys, publications and privileged tasks all refuse it. On 2026-10-07 this status was success for all seven repositories.
- **Residual risk (please record it as "risk accepted")**: a direct push to `main` of a private repository cannot be prevented; it can only be detected within about 5 minutes and denied any output. Keep write access limited to the two maintainers; a red or long-stale `Main Write Guard` status is the alarm.
- **Suggested review date to record**: review again the next time someone proposes "make a private repository public" or "upgrade the plan"; otherwise once a year.
- ⚠ Before merging any change to `policies/rulesets.json`, read the ORG-006 proposal in action-worker `#439`: on merge to main it is applied automatically to **the four public repositories** (action-worker, ai-gateway, delta, external-vault).

---

## Step H (ORG-011): organization-level review

- **Organization secrets / variables** (needs `admin:org`)
  ```bash
  gh api orgs/fongap-labs/actions/secrets --jq '.secrets[] | {name, visibility, updated_at}'
  gh api orgs/fongap-labs/actions/variables --jq '.variables[] | {name, visibility}'
  ```
- **Webhooks and deploy keys (every repository)**
  ```bash
  for r in delta action-worker external-vault ai-gateway internal-vault delta-suite app-source; do
    echo "== $r"; gh api "repos/fongap-labs/$r/hooks" --jq '.[]|{name,active,url:.config.url}' 2>/dev/null
    gh api "repos/fongap-labs/$r/keys" --jq '.[]|{title,read_only}' 2>/dev/null
  done
  ```
- **Fine-grained PAT policy**: Organization Settings → Personal access tokens → Settings (whether approval is required, whether classic PATs are allowed) and Active tokens (lists the approved tokens).
- **Audit log (last 90 days)**: Organization Settings → Archive → Audit log (UI). Reading the audit log through the API needs Enterprise Cloud and is not available to a Free organization.
- **The three dispatch / control / admin tokens** (`AW_DISPATCH_TOKEN` / `AW_CONTROL_TOKEN` / `AW_ADMIN_TOKEN`): find out whether each is a PAT or an App token — check whether the workflows use `actions/create-github-app-token` (`grep -rn create-github-app-token .github`), and confirm with whoever created them. Record: type, permissions, expiry, rotation owner. `gh secret list` shows only names and update times and never exposes values.
- **Rollback**: this step is read-only and needs no rollback.

---

## Self-check after completion

| Check | Method |
|---|---|
| App permissions reduced | the output of step A command 1 contains no `workflows`, `secrets` or `organization_secrets` |
| Private vulnerability reporting | step D verification: all four public repositories return `true` |
| Read-only token ready | `gh secret list --repo fongap-labs/action-worker` contains `AW_CHECKOUT_TOKEN` |
| Environments created | C1 verification: `deployment-branch-policies` is `main` |
| Secrets isolated | test 1 and test 2 after C3 |
| Platform SHA pinning | the CI of the pilot repository in step F passes, and a floating tag is refused |

---

## Appendix: follow-ups and decisions after this round of fixes (updated 2026-10-07)

> Premise (owner decision): Free organization; private repositories stay private long-term.

### Done

- With your authorisation I merged 41 PRs in order (fixes and tests in action-worker, ai-gateway, app-source, delta, delta-suite, external-vault and internal-vault); every merge was a squash, and auto-merge was never turned on.
- I added a permission rule to `C:\Users\Fong\.claude\settings.json` that allows only `gh pr merge … --squash` for fongap-labs; delete it when it is no longer needed.

### PRs not merged yet

| PR | State | Waiting for |
|---|---|---|
| external-vault `#48` | all checks green | a manual check by you first: temporarily add `ghp_` plus 36 alphanumeric characters to `adfilter.txt`; it should raise an alert. Then I merge it |
| action-worker `#439`, delta `#118`, internal-vault `#54`, app-source `#44` | proposal documents only | your decision |
| delta `#119` | removes 10 revoked gtk3 ignore entries from deny.toml | a quick review, then merge |
| Dependabot: internal-vault `#55`–`#64`, app-source `#45`, delta `#103`–`#112` | checks are red (untrusted author, no CI evidence) | see "Dependabot advice" below |

### Dependabot advice (I did not touch any of them)

These PRs have red checks because the author is a bot and not a trusted author: for CI to run, you (or fongxen) must review and Approve on GitHub first, and then the checks run. I do not do this step for you.

- **Low risk, review first**: internal-vault `#55` (ruff patch), `#57` (mypy minor version, may add a few type errors); app-source `#45` (cryptography 50.0.1→50.0.2, patch); delta `#107` (ruff patch), `#105` (simple-icons patch), `#103` (front-end dev dependency group).
- **Do not merge yet; needs a matching code change**: internal-vault `#59`, `#60` (boto3 1.35→1.43). Since 1.36, boto3 adds checksums to uploads by default, which Cloudflare R2 often rejects; `bricks/r2_storage_upload.py` does not set `request_checksum_calculation="when_required"` yet. Change that setting together with the upgrade and test one R2 upload.
- **Major versions, high risk**: internal-vault `#56` (pandas 2→3), `#61` (yfinance 0.2→1.7), `#62`, `#64` (pyarrow 23→25, related to pandas; the code reads and writes parquet a lot). Do a separate upgrade round and run the full market data fetch flow for each one. `#63` (tushare patch) and `#58` (packaging 24→26) are medium; do them after that batch.
- **The Tauri series must be upgraded together**: delta `#104`+`#108` (opener front end / Rust as a pair), `#106` (@tauri-apps/api), `#109` (updater; it concerns the updater, review it first), `#110`, `#111`, `#112`. The major versions of the Tauri front-end packages and Rust crates must match; merging one alone can make the build fail with a "version mismatch". Close these individual PRs and do one combined upgrade with a real build to verify it.

### Manual actions for you

- **Create `AW_ARTIFACT_KEY`** (once, about 2 minutes). Without it, private tasks keep no state between runs and their failure logs are not kept. In Git Bash:
  ```bash
  openssl rand -base64 32 > ~/aw-artifact.key
  gh secret set AW_ARTIFACT_KEY --repo fongap-labs/action-worker < ~/aw-artifact.key
  ```
  Keep `~/aw-artifact.key` private (for example in your password manager): it is needed to read a failed private task log (see `docs/ARCHITECTURE.md` section 9.3). If it is lost, create a new one; old encrypted state is then ignored and the next run starts fresh.
- **The GitHub settings of P-00** (A, B, C1/C2, D, E, F, H): see the steps above; **C3 (deleting repository-level secrets) waits until AW-002 is implemented and rehearsed successfully**.
- The Windows code signing certificate, and the two secrets for it in a protected environment (delta `#117` is merged; without the certificate the build does not change).
- The backup contact in SECURITY.md (marked TODO in the action-worker `SECURITY.md`).
- On the server host: Tailscale auth key attributes, sudoers / authorized_keys, and checking the format of the real instance `.env` (see internal-vault `#54`).
- Ask legal to confirm the licence combination of the AdFilter aggregate file (see external-vault `#47`).
- Create the code-pepper file of the license service; decide the default of "do not wrap the file key for a temporary public key" in the temporary access GUI.
- The old clone can be deleted: `C:\AgentHub\fongap-labs\action-worker`.

### Decisions waiting for you

| Item | In which PR | My recommendation |
|---|---|---|
| Isolating secrets with environments, and what the task path does (A/B/C) | action-worker `#439` | do the deploy path only first; the environments all live in the public action-worker, so "Free + private" does not affect them |
| CI control paths (AW-005) | `#439` | fixed commands for standard tools; document the rest |
| Stricter branch rules (ORG-006) | `#439` | affects only the 4 public repositories; "strict status checks" first, then consider "1 required approval + an emergency bypass" |
| Credential storage (DL-002) | delta `#118` | do step 1 first (files are restricted on creation, judged by SID) |
| Server deploy hardening (IV-004/005) | internal-vault `#54` | (a)(c)(e) can be done; for (b), choose a trust anchor first |
| Author key file SPKEY02 (APP-007) | app-source `#44` | scrypt N=2^16; a new file, the old file is not overwritten |
| **Version number to release (APP-011)** | app-source `#44` | please tell me: 2.0.0 or 0.1.0 |
| Pinned gitleaks in central CI | action-worker `#436` description | as a separate step |

### Static checks for private repositories (instead of CodeQL)

CodeQL for private repositories is a paid feature, so I ran a one-off replacement scan on this machine (CI was not changed):

- internal-vault (bandit): no high findings; 9 medium, mostly fixed /tmp paths and a Hugo download whose hash is verified; the only one worth noting is that `bricks/source_fetch.py` parses external RSS with `ElementTree` (switching to `defusedxml` is recommended, low priority).
- delta-suite (bandit): no high findings; the 2 medium ones are SQL concatenation warnings, and the values are bounded by `resolve_limit`, so they are not injections.
- app-source (clippy + cargo-deny): no errors, only 6 style warnings; `cargo deny check advisories` passes.
- Note: central CI hides detailed logs for private repositories, so if these scans are added to CI later, they can only report pass/fail and details must be reproduced locally. Whether to add them to CI is your decision.
