# Changelog

## [Unreleased]

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
