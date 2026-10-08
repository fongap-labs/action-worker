# Changelog

## [Unreleased]

- docs: record that `CLOUDFLARE_API_TOKEN` holds the tokens of two different Cloudflare accounts: the `production` environment copy belongs to the ai-gateway deploy and the repository-level copy to the internal-vault tasks, so the repository-level copy must not be deleted in the P-00 secret isolation steps.
- fix: PR Governance no longer holds a runner for up to 120 minutes while Central CI runs. It checks `CI Evidence` once and, while CI is running, ends as pending "Waiting for Central CI"; Central CI dispatches governance again once it has a verdict for the current head. A failure from a Central CI run of the current control commit is not re-run automatically. Central PR Intake treats a waiting PR as in flight while its pending CI Evidence is younger than 200 minutes. Under the 20 concurrent jobs of the Free plan, waiting governance runs can no longer starve the CI they wait for.
- fix: when Central CI for a pull request stops in its prepare job (for example because an untrusted author changed a CI control file), it now writes `CI Evidence = failure` to the current head with a link to the run. Before, the pending status stayed pending and PR Governance waited 120 minutes before it timed out.
- fix [security]: task state and failed task logs of a private task source are uploaded only encrypted with the new secret `AW_ARTIFACT_KEY` (AES-256-GCM, bound to the kind, repository and project); without the key nothing private is uploaded. The previous state is now found by its artifact name and accepted only from a successful run of `handle-task-dispatch.yml` on `main`, instead of scanning the last 50 runs, so a project that runs rarely keeps its state. The owner reads a failed private task log with `node scripts/task-state.ts open-log`.
- docs: write every Action Worker document that people and agents work from in English (`CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `docs/`, the proposals and `p00-owner-checklist.md`). Chinese stays only in `*.zh-CN.md` localization files, now including `SECURITY.zh-CN.md`, and `tests/documentation-language.test.ts` enforces it. `docs/NAMING_CONVENTIONS.md` records the rule and the workflow naming rule. Business repositories keep the existing Markdown exemption of the engineering language check.
- ci: name every workflow by one rule within the existing three-segment limit, checked by `tests/workflow-naming.test.ts`. A workflow started by `repository_dispatch` takes the most complete name that fits: `handle-<subject>-dispatch.yml`, then `<subject>-dispatch.yml`, then `<subject>.yml`, where the subject is the event name without `run-`. Every display name now spells out its file name. Renamed `dependency-repair`, `security-scan` and `release-build` to `*-dispatch`, and `apply-repo-settings` (workflow and script) to `apply-repository-settings`; renamed the display names of the intakes (for example "Central PR Intake" is now "PR Intake") and of the other dispatch entry points. `handle-pr-dispatch` and `handle-pr-review` are recorded exceptions. Removed the reusable workflows `validate-central-merge`, `validate-deploy-policy` and `validate-source-policy`, which no repository called.
- test: cover the R2 client configuration of the internal-vault upload brick (checksums only when required, plain settings for older botocore).

- fix [security]: stop uploading the output of a failed private task as a `task-log-*` artifact. Artifacts of the public action-worker repository can be downloaded by any signed-in GitHub user, which bypassed the suppression of private task output in the run log; the log now stays on the runner.
- fix: stop re-dispatching PR Governance every five minutes for a pull request that waits for approval. An untrusted head is now reported as `Awaiting maintainer approval of the current head commit` (the run itself succeeds, `PR Governance` and `validate-merge` stay `failure`, and the PR comment explains how to approve); Central PR Intake recognises that state and dispatches again only once a maintainer approved the current head. Dependabot pull requests from a branch of the same public repository no longer wait for approval; in private repositories they still do. Central CI keeps failing closed on an untrusted head.
- fix [security]: the PR gate accepts `CI Evidence` only when the control run it names is a successful run of a workflow that publishes it (`hasVerifiedCiEvidence`), and `dispatch-central-ci.ts` no longer skips CI on a success status that merely names a control run URL. Central CI dispatches its follow-ups (security scan, Main Write audit, automatic deploy) from a separate `follow-up` job with `continue-on-error: true`, so a follow-up failure cannot turn a passing CI run red.

- feat [security]: add a central, pinned secret scan of the commits a pull request adds (gitleaks 8.30.1 with a verified SHA-256, `scripts/central-secret-scan.ts`) to the Linux CI sandbox. It runs before any target code, uses the target's `.gitleaks.toml` from the trusted ref when it has one, prints rule names and counts (file and line only for public repositories) and only warns by default; set the Repository Variable `AW_CENTRAL_GITLEAKS_MODE` to `enforce` to make findings fail the build.

- fix [security]: the main-branch ruleset now requires a pull request to be up to date with `main` before it can merge (`strict_required_status_checks_policy: true`), so `validate-merge` runs on the result of the merge. It applies to the public repositories; private repositories on the Free plan cannot have rulesets and rely on the Main Write Guard (ORG-006, phase 1).

- docs: record the owner decision that the organization stays on the Free plan and the private repositories stay private in the ORG-006 and AW-002 proposals (rulesets apply to the four public repositories; the Main Write Guard is the control for the private ones).

- docs: add design proposals for owner approval, with nothing implemented: AW-002 (isolate deploy and task secrets with Environments), AW-005 (what a pull request may change about its own CI) and ORG-006 (main-branch ruleset hardening), under `docs/proposals/`.
- test: cover owner-only credential files in the delta pack: SID-based ACL judgement (no dependence on the Windows language), creation with mode 0600, reporting of an unconfirmed protection and of a failing folder restriction, and a loose file restricted by the next save on Windows.
- test: cover the Server Edge hardening in the internal-vault pack: the strict env loader rejects anything that could run or surprise, release defaults load like `source` did, configuration backups are pruned to three, and `deploy.sh` never downloads or runs the Tailscale installer without a matching pinned hash.
- feat [security]: the source-script deploy path now takes its authority from the control plane. `policies/deploy-environments.json` lists the environments each repository may deploy to (the manifest only requests one, an unlisted request fails with exit code 77), `policies/deploy-secrets.json` caps the secrets a target may declare per repository and environment (`AW_DEPLOY_SECRET_POLICY_MODE` `warn` by default, `enforce` to refuse), the deploy checkout uses the read-only `AW_CHECKOUT_TOKEN` instead of `AW_CONTROL_TOKEN`, and the control-plane credentials are refused as declared names. Jobs that use `AW_ADMIN_TOKEN` now run in the `admin-ops` environment.

- test: cover the AdFilter build header in the internal-vault pack: every source and its licence appear as Adblock Plus comment lines, the rule count and rules are unchanged, and a configured value cannot inject a rule line.
- test: cover the delta-suite browser hardening: non-web request protocols are aborted, the guarded proxy demands per-session credentials (407), refuses CONNECT to non-web ports, releases idle connections and answers 503 beyond its connection cap.

- test: cover the delta web-fetch size and time limits, the URL guard's rejection of embedded credentials and IPv4 forms, and the shared credential-redaction golden fixture in the delta test pack.
- test: cover the app-source license service hardening: bounded audit rows per client address with one summary row, hourly retention, the 4 KB body limit, the per-(ID, address) failed-attempt limit, the pepper file, and the nonce-based Content-Security-Policy.
- test: cover the ai-gateway hardening in its pack: OAuth page CSP and the refresh-page form start, edge cache stream and credential scoping and unsafe-response skipping, token AAD binding, diagnostics key groups, the subscription and public dashboard switches, and the waitUntil purge.
- docs: add `SECURITY.md` (English and Chinese) pointing to GitHub private vulnerability reporting; the backup contact is a TODO for the owner.

- docs: describe the Gate as deterministic policy plus CI Evidence, with AI Review running asynchronously after the gate passes and only advising (README.md, README.zh-CN.md); drop the "review blocking thresholds" bullet, which has no policy behind it.

- fix [security]: task state artifacts are named `task-state-<hash of repository and project>` and carry a `manifest.json`; restore ignores an artifact whose manifest names another repository or project, so two different task sources can no longer share or poison each other's state (artifacts written under the old name are still restored during the 30 day retention window). For a private task source the public run log shows the project and request id only as short hashes and the commit as 7 characters.
- ci: add `.github/security-scan.json` so Action Worker's own TypeScript and workflow files are scanned by CodeQL, and accept the CodeQL `actions` language in the security scan contract (`contracts/security-scan.json`, `scripts/security-scan.ts`).
- fix: the engineering language rule no longer reports non-English text inside vendored minified bundles (`*.min.js`, `*.min.css`), which the repository that vendors a library cannot change; the same text in authored code is still reported.
- feat [security]: the security gate now also reports OpenAI/Anthropic (`sk-ant-`, `sk-proj-`, legacy `sk-` keys), NVIDIA `nvapi-`, Hugging Face `hf_`, Tailscale `tskey-`, `CLOUDFLARE_API_TOKEN` assignments and JWTs in added lines, and `policies/security.json` gains `secret_allowlist`: a known harmless value is accepted only when both its file path and the whole matched text match, so it cannot excuse any other credential on the same line or in the same file. The only entry is the synthetic key in the internal-vault preflight tests.
- fix [security]: check out private targets in the CI sandbox and the dependency repair compute job with a new read-only `AW_CHECKOUT_TOKEN` instead of `AW_CONTROL_TOKEN`, so jobs that run change code never hold a write-capable credential.

- fix [security]: stop persisting checkout credentials in the dependency repair publish job, the validation workflows and the task dispatch workflow (the push now authenticates through the environment), and split `security-scan.yml` so CodeQL runs without secrets and only a separate publish job holds `AW_ADMIN_TOKEN`.

- test: add workflow invariants that fail when a code-executing job references a central secret, a checkout persists credentials, or the CodeQL job gains a secret.
- test: make the delta-suite browser proxy tests work with proxies that require credentials and restrict CONNECT ports, while still passing against the current proxy.

- test: accept the refresh page that the ai-gateway OAuth form start returns after a form submit, alongside the previous 302, and stop asserting that a streamed request shares the edge cache entry of a non-streamed one, so the gateway fixes can merge without breaking this pack.

- fix [security]: re-verify the task source in `handle-task-dispatch.yml` before any task runs; `bootstrap_ref` must be the current default-branch HEAD of the target repository, carry verified CI Evidence and pass the Main Write Guard, so a forged `run-task` dispatch can no longer make the executor run an arbitrary commit.

- fix [security]: verify `CI Evidence` against the control-repository run that produced it (publishing workflow, default branch, successful conclusion, status written during the run) in the deploy source gate, the task source gate and the Main Write Guard, instead of trusting the `target_url` prefix.

- feat: add `policies/task-secrets.json`, a central ceiling for the secrets a task source may declare per repository and project; `AW_TASK_SECRET_POLICY_MODE` selects `warn` (default) or `enforce`.

- fix: scheduled task dispatches now use a `task-schedule-<identity>` request_id (hyphen separator) so they pass the payload validator's `[A-Za-z0-9_.-]` format check; the previous `task-schedule:<identity>` (colon) was rejected at intake, failing every scheduled task (MarketBrief, PharmaBrief, FongapBlog, AdFilter).

- fix [security]: pin the AI review engine binary by SHA-256 in `policies/review.json`; the installer accepts it only when the binary matches the pinned digest and the release checksum file agrees, so a replaced release asset cannot vouch for itself.

- build: resolve every npm package from `registry.npmjs.org` instead of a third-party mirror (integrity hashes unchanged).

- test: cover the ai-gateway `/health` node visibility per access key and the single-use OAuth flow state under concurrent callbacks, and teach the OAuth mock D1 the atomic `DELETE ... RETURNING` read.

- test: cover the internal-vault lockfile-pinned Wrangler runtime for the Cloudflare deploy bricks and the masking of short and multi-line secrets in the internal-vault test pack.

- test: cover the delta-suite git authorization header (scoped to the GitHub host, passed to clone and pull) in the delta-suite test pack.

- test: cover the ai-gateway edge cache key (canonical JSON, distinct value types, scoped to the key group) in the ai-gateway test pack.

- test: cover the ai-gateway onboarding key-group limit (`AIG_OAUTH_ADMIN_GROUPS`) in the ai-gateway test pack.

- fix [security]: run central CI for a pull request whose author has no write access only after a maintainer approves its current head commit, and re-check this inside the central CI workflow before any change code runs.

- fix [security]: move the Linux and Windows central CI jobs into the `central-ci-sandbox.yml` reusable workflow, which references no central secret and receives a checkout token only for private targets.

- fix [security]: start deploy and task entrypoints with `exec` after out-of-scope secrets are unset, and keep the output of tasks from private repositories out of run logs.

- fix: list the actual maintainers in CODEOWNERS instead of a team that does not exist.

- fix: skip the automatic deploy step for repositories that do not have the `deploy` capability instead of failing with exit 77, so a green main push of delta, delta-suite, app-source or external-vault no longer ends in a red Central CI run.

- fix [security]: install actionlint in Validate CI from a pinned release with a verified SHA-256 instead of executing a script fetched from the `main` branch.

- fix [security]: pass `needs.*.outputs` to shell steps in the CI dispatch, dependency-repair, release-build and security-scan workflows through `env` instead of pasting them into the script text, and add the `expression-as-shell-argument` rule to the security gate so the pattern cannot return.

- test: add static hygiene checks for the delta-suite test pack (HTTP-helper keywords that do not exist, credentials in URL query strings, tokens on the git command line).

- test: add HTTP-level tests for the app-source license service (admin token, real client IP for rate limits, input clamping, log hygiene, signing with the redeem code's edition and features, optional code pepper).

- fix: keep reviewing and commenting on a pull request that was merged while its advisory AI Review waited or ran, instead of dropping the review; a pull request closed without merging is still skipped.

- fix: run advisory AI Review as its own workflow that starts only after the deterministic gate passes, so a pull request no longer waits in the AI queue behind unrelated runs that are still waiting for central CI, and the governance run ends when the gate does.

- feat: let a managed repository split its Linux CI into parallel shards by declaring `matrix.shard` on the `linux` job of its trusted Execution Manifest, so CI wall time becomes the slowest shard instead of the sum of all phases; repositories without shards keep their exact single-job invocation.

- feat: add an approved thin PR dispatcher template whose runner is resolved centrally, with a self-hosted control profile, and let the security gate exempt a workflow only while it is byte-identical to an audited hash.

- test: follow the internal-vault#43 brick rename to global_market_fetch and assert the fake token body instead of a contiguous credential literal in the internal-vault test pack.

- test: assert the English Hugo checksum error message in the internal-vault test pack, matching the English-only messages of internal-vault#43.

- test: sync the ai-gateway test pack and shared mock D1 helper with the test changes of ai-gateway#65 (one added case, none removed) and replace its inventory baseline.

- test: sync the internal-vault test pack with the test changes of internal-vault#43 (15 added cases, none removed) and replace its inventory baseline.

- fix: keep central PR intake running when an open pull request touches a file name outside the safe alphabet, such as a non-ASCII name, by treating it as not eligible for dependency repair instead of aborting reconciliation of every repository.

- feat: add the `app-source` test pack for the license-service database tests and document the state of every managed repository in `docs/TEST_PACKS.md`.

- feat: centralize product test suites as Action Worker test packs with a shared test kit, a pack runner, a pre-migration case inventory, and `.github/test-pack.json` as a protected CI control path.

- fix: raise the security gate diff buffer so large generated publication artifacts can be scanned instead of exceeding the 16 MiB cap.

- fix: exempt plain data content files from the engineering language gate so generated publication artifacts can pass governance.

- fix: land task publication through a governed pull request instead of a direct push to the protected target branch.

- fix: accept central CI Evidence as the release source gate when source repositories no longer host local ci.yml runs.

- fix: merge code-minimality review guidance into the single OpenCodeReview rule entry per file so it reaches the AI review model instead of being dropped as a duplicate path-pattern entry.

- feat: add a code-minimality agent skill and AI review rules that prefer reuse, deletion, and minimal change sets without weakening safety or gates.

- fix: detect PR project types from changed monorepo paths before falling back to repository-root manifests.

- fix: surface detailed source-naming diagnostics when the Python naming validator rejects a change.

- fix: reserve short-lived `CI Evidence` before main-CI intake dispatch so adjacent reconciliation runs cannot launch duplicate Central CI for the same immutable head.

- chore: standardize GitHub workflows on the pinned `actions/setup-node@v7.0.0` runtime and reject the retired v4 action pin.

- refactor [breaking]: hard cut the duplicate `ci-evidence` commit-status alias and keep `CI Evidence` as the single canonical Central CI status context.

- fix: serialize duplicate main-SHA Central CI dispatches and reuse successful CI Evidence instead of cancelling and rerunning the same immutable source.

- fix: reserve short-lived PR intake statuses before dispatch so repeated reconciliation cannot launch duplicate Governance or Dependency Repair runs for the same head.

- fix: retry failed PR governance after the Action Worker control revision advances while avoiding retry loops on the same revision.

- fix: expose only trusted CI script line and exit code for private-repository failures while keeping detailed logs suppressed.

- refactor: resolve closed-PR cancellation repository authority through AW_REPOSITORY_POLICY instead of a duplicated workflow allowlist.

- fix: validate closed-PR cancellation targets before entering governance and Central CI concurrency groups.

- fix: cancel stale PR Governance and Central CI work when a managed pull request is closed.

- fix: reserve validate-merge for the trusted GitHub Actions check and stop Central CI from publishing a conflicting commit status.

- fix: inject the validated AI Gateway source SHA through AIG_BUILD_SHA instead of the control-plane GitHub SHA.

- feat: centralize repository Main and Legacy Ruleset creation and drift repair in Action Worker.

- docs: remove obsolete AW_EXECUTION_TOKEN guidance and document GitHub Free private-repository protection limits.

- docs: replace the stale exhaustive architecture tree with the current responsibility-based control-plane layout.

- feat: inject Tier 2 OAuth provider configuration and token-encryption key only through the central AI Gateway deploy and readiness workflows.

- fix: publish explicit successful CI Evidence when the governance plan does not require CI so final merge gates never infer intent from missing evidence.

- refactor: enable automatic AI Gateway deployment through the central deploy executor and register manual Server Edge deployment policy.

- feat: centralize Server Edge deployment execution and production credentials in Action Worker.

- feat: add a source-gated central AI Gateway deployment executor with centralized production credentials, health verification, and rollback.

- feat: move AI Gateway nightly CI into Action Worker without publishing deploy-triggering commit statuses.

- feat: add non-destructive central deployment readiness checks for AI Gateway and Server Edge.

- fix: skip centralized model discovery safely until its provider configuration is available in Action Worker.

- feat: centralize AI Gateway model discovery and snapshot retention in Action Worker.

- feat: extend centralized Release Build to Delta with project-scoped environment setup, provenance attestation, and CycloneDX SBOM packaging.

- feat: centralize App Source release build runners, artifact packaging, and provenance in Action Worker.

- fix: key Release Governance concurrency by the v2 source and artifact identities.

- fix: include deleted files in PR context so workflow removals still trigger CI and governance.

- test: run centralized tool-sync smoke validation when its control files change on main.

- feat: centralize verified third-party tool synchronization and Release artifact preparation in Action Worker.

- refactor [breaking]: split Release Governance source identity from artifact-run identity and require signed-by-contract release provenance.

- fix: register Delta as a canonical external configuration owner so repository-independent names use the stable DELTA prefix.

- fix: satisfy the GitHub Checks API contract when creating the centralized validate-merge check run.

- refactor: trigger merge gates from the final PR Governance commit status and remove reverse cross-repository dispatch credentials.

- fix: trigger repository merge gates through repository_dispatch and centralize GitHub Actions check creation in one reusable workflow.

- refactor: reuse `AW_CONTROL_TOKEN` for private task bootstrap reads and remove the redundant `AW_EXECUTION_TOKEN` credential contract.

- fix: use the repository administration credential for cross-repository merge-gate workflow dispatch while keeping PR control credentials read-only for Actions.

- fix: preserve GitHub Actions required-check identity with a lightweight repository merge gate and expose central CI failure details only for public targets.

- fix: allow centralized CI evidence waits up to two hours while keeping PR governance within its three-hour execution budget.

- feat: extend centralized CI execution to every managed business repository while retaining project-owned trusted test entrypoints.

- fix: honor disabled AI review authority for every repository, including AI Gateway bootstrap, so model overrides cannot silently re-enable review.

- fix: give normal code AI reviews a five-minute task budget so the outer review process can cover the configured 300-second LLM timeout.

- fix: keep the context-selected AI review active for a trusted bootstrap model override and validate that explicit model against the Agent key before review execution.

- fix: use the centrally configured independent writing model for temporary AI Gateway bootstrap review while preserving architecture rules, high effort, CI evidence, and critical blocking.

- fix: use the centrally configured default AI review model for AI Gateway bootstrap while preserving architecture rules, high effort, CI evidence, and critical blocking.

- fix: run AI Gateway bootstrap review one capability tier below an Ultra architecture route so the current gateway can be repaired without disabling AI Review or hard-coding a model family.

- fix: preserve AI review bootstrap compatibility by resolving AI Gateway self-review from the centrally authorized architecture route instead of a hard-coded model alias.

- fix: allow AI review rate-limit retry windows to use a ten-minute task budget without weakening governance gates.

- fix: temporarily review AI Gateway changes with the authorized Audit-Max model to break the gateway self-review bootstrap cycle without disabling AI Review.

- fix: align the default AI review task budget with the configured 300-second LLM timeout.

- fix: classify CHANGELOG updates as documentation so release review is selected only by actual release semantics or declared release impact.

- style: align work-metric value colors with the GitHub brand palette.

- style: use default Shields label backgrounds and GitHub label colors for work-metric values.

- style: apply a visually reviewed muted palette to work-metric badges.

- style: use a muted low-saturation palette for work-metric badges and lighten shared labels.

- style: rename the Dispatch badge to Task Dispatch and unify work-metric badge colors.

- fix: give architecture and security AI reviews a five-minute task budget so high-effort Audit-Ultra reviews can complete within the configured 300-second LLM timeout.

- fix: define Dispatch as successful Handle Task Dispatch runs and lock work-metric badge semantics in tests and documentation.

- fix: update all work-metrics badges from completed governance events, synchronize localized READMEs, and wait for PR CI without workflow-dispatch permissions.

- docs: make English the default repository documentation language and add Simplified Chinese companion indexes.

- fix: distinguish engineering lifecycle labels from qualified domain concepts in shared naming validation.

- fix: isolate read-only task execution credentials from central control and publication credentials before downstream bootstrap execution.

- fix: use `AW_CONTROL_TOKEN` only for work-metrics PR creation while keeping local Actions and cleanup on the workflow-scoped token.

- fix: trigger the stale metrics-branch sweep when its implementation script changes on main.

- fix: force GET for stale-metrics pull-request discovery so GitHub CLI does not reinterpret query fields as a PR creation request.

- fix: execute stale metrics-branch cleanup in the standalone sweep job rather than the gated aggregation job.

- fix: bootstrap stale metrics-branch cleanup when the metrics workflow itself changes on main.

- fix: run stale work-metrics branch cleanup independently of source workflow success.

- fix: sweep stale closed work-metrics branches before each metrics update.

- fix: accept the `APP_SOURCE_` external configuration prefix as a context-independent system identity.

- fix: keep work-metrics repository actions on the workflow-scoped GitHub token and clean failed metric PRs and branches.

- fix: recognize scoped business owners in external configuration naming while continuing to reject generic context-dependent names.

- feat: derive task-runtime AI Agent model variables from `AW_AI_AGENT_CONFIG` so downstream writing and future agents share one model authority without project-level model settings.

- refactor: centralize optional AI Agent enablement and logical-model routing in `AW_AI_AGENT_CONFIG`, keeping Review, Triage, Writing, and future agents under one runtime configuration authority.

- fix: run release AI review on Code-Max while preserving the same strict blocking policy.

- feat: preflight AI Gateway model access so governance fails early when the Agent key cannot call required review models.

- fix: give release AI reviews a five-minute task budget so transient gateway failover can complete without weakening review gates.

- fix: include JSONC deployment configuration and CHANGELOG files in release AI review scope.

- fix: make AI Triage and Review opt-in through AW_IS_AI_REVIEW_ENABLED while preserving deterministic governance gates.

- fix: give workflow AI reviews a five-minute task budget without increasing other review-agent timeouts.

- fix: treat MODE configuration names as non-Boolean during naming validation.

- fix: add bounded exponential-backoff session recovery for transient AI review failures while preserving FIFO single concurrency.

- fix: move review distribution and release repository allowlists into versioned governance policy.

- fix: resolve the OpenCodeReview distribution repository from the canonical Action Worker repository variable.

- fix: enforce canonical governance configuration names, execution-source allowlisting, and governance-token metrics mutations.

- refactor [breaking]: namespace Action Worker external configuration with AW/AIG system identity and enforce context-independent external names.

- docs: define minimum-sufficient external naming and register AW/AIG system abbreviations.

- fix: prioritize context-independent configuration semantics over arbitrary segment-count limits.

- refactor [breaking, migration]: hard cut shared configuration names and reject non-canonical configuration identifiers.

- perf: bound each normal Code-Pro review task to two minutes so multi-file governance remains responsive while gateway fallback and fail-closed behavior stay unchanged.

- perf: inject controlled CI evidence into matching ephemeral base/head commits so it remains readable without becoming an extra reviewed file.

- fix: order AI Review reruns by the current attempt start time so a reused low run ID cannot bypass the global FIFO queue.

- fix: expose controlled CI evidence to commit-based AI Review through an ephemeral local commit without changing the governed PR head.

- perf: limit transient OpenCodeReview session recovery to one checkpoint-preserving resume after production validation showed a single resume is sufficient.

- refactor: remove the temporary npm bootstrap now that verified OpenCodeReview release assets are published.

- perf: use one-round Code-Pro review for normal workflow/release changes; Triage still escalates high/deep risk to Code-Ultra/high.

- fix: temporarily allow npm bootstrap only when the configured OCR Release asset is confirmed missing (HTTP 404); remove after the first mirrored Release is published.

- fix: serialize Triage and AI Review across Action Worker revisions so a main update cannot create concurrent AI Gateway callers.

- refactor: install OpenCodeReview from verified external releases with runner cache instead of npm.

- fix: resume one compatible OpenCodeReview session after transient 5xx, timeout, network, or overload failures without repeating completed review work.

- feat: add per-Release license metadata with Apache-2.0 as the default and explicit App-level overrides.

- feat: add Code-Air AI Triage before normal PR review, with deterministic safety floors and high-confidence low-risk review skipping.

- refactor: keep Triage and AI Review on one FIFO queue, remove whole-review retry, and delegate request retry to OpenCodeReview plus model/provider/key fallback to AI Gateway.

- fix: clean temporary metrics branches when automated PR creation is rejected.

- fix: use the repository-scoped GitHub token for local work-metrics PR creation and merge.

- feat: centralize changed-source naming validation for Python, Rust, and TypeScript.

- fix: serialize OpenCodeReview subtasks through policy-defined review concurrency to avoid upstream provider burst failures.

- fix: prevent stale PR governance runs from overwriting review comments or final commit status owned by a newer run.

- fix: scope PR governance concurrency to the current control-plane revision so stale runs cannot block a newer Action Worker release.

- fix: surface OpenCodeReview manifest failure classifications and reasons in governance logs.

- feat: recompute and auto-update task dispatch, PR governance, and release governance work metrics daily.

- fix: unify on `main` as the latest control baseline and remove residual `v1` references.
