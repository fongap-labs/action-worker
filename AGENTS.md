# AGENTS

## Common rules

- Inspect the requested branch, source SHA, relevant code and existing contracts before editing. Do not read unrelated trees or expand the task.
- Reuse existing implementations; fix the root cause. Delete obsolete code. No speculative features, duplicate abstractions, unnecessary dependencies, fallback stacking or new workflows.
- Own boolean variables and parameters must use is/has/can/should: `enabled` -> `isEnabled`, `retry` -> `shouldRetry`; Python/Rust: `is_enabled`. Preserve external protocol names.
- Use precise language-native identifiers. Governed file names: `helper.ts` -> `validate-token-format.ts`. Own external configuration: `AW_TOKEN` -> `AW_STATUS_TOKEN`. Use three semantic segments; preserve standard platform names.
- Comments: add or retain only if omission would cause a concrete foreseeable error. Delete optional explanations, code narration, decorative separators and commented-out code. Preserve required legal notices, machine directives and external contracts.
- Tests: verify necessary observable behavior, security and regressions. Extend existing coverage before adding tests. Delete redundant or retired tests; never weaken useful coverage. Externalizable tests belong in the central test packs; local tests require an existing approved exception.
- Update existing authoritative documentation; no duplicate guides, task summaries or speculative plans.
- Commit and PR titles: only feat/fix/chore, in English (e.g. `fix(auth): reject invalid token`). Every commit requires a blank line and a substantive Chinese body explaining why and what changed. No AI attribution.
- Update only the Unreleased section of CHANGELOG.md with matching Chinese entries (feat=addition, fix=correction, chore=maintenance); do not rewrite released history.
- Use the declared target branch; omitted targets mean main. main is stable/production; dev is Beta only when enabled. Never fall back to another branch. No direct protected-branch writes, cross-branch transfer or history rewrite without the applicable authorization.
- No secrets in code, logs or untrusted execution. No bypass of security, CI, merge or release gates. Never change tests merely to obtain green status.
- Run the applicable central preflight before submission; fix introduced failures. Verify the final diff and actual outcomes. Report unverified checks and blockers; never claim success without fresh evidence.

## Repository rules

- Action Worker is the central governance authority: keep control logic generic, no product-specific runtime logic or second authority. Keep contracts, implementation, necessary tests and docs consistent.
- Development branch disabled by default; use main unless the central policy explicitly enables dev.
- Run `npm run preflight -- full` and `npm run check` as applicable. For API-only changes report checks that cannot be executed locally; remote gates remain authoritative.
- Load skills/agent-execution/SKILL.md and relevant skills/*/SKILL.md only when needed for detailed execution. Read relevant contracts, policies and architecture docs for boundary changes.
