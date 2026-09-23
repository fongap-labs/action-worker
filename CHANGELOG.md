# Changelog

## [Unreleased]

- style: rebalance work-metric badges with distinct muted blue, warm gray, navy, and teal accents.

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
