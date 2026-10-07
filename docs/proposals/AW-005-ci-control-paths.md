# Proposal AW-005: what a pull request may change about its own CI

Status: **awaiting owner approval. Nothing here is implemented.**

## 现状

- `scripts/resolve-ci-control-ref.ts` decides which ref the central CI script is read from. `CONTROL_PATHS` holds four files: `.github/execution-manifest.json`, `.github/scripts/central-ci.sh`, `.github/scripts/central-ci.ps1`, `.github/test-pack.json`. If a PR changes none of them, the CI control files come from the **base** branch; if it changes one, the PR head is used, but only for a same-repository PR by an `OWNER`/`MEMBER`/`COLLABORATOR`; anything else is rejected.
- The control script is therefore trusted, but what it runs is not: it executes commands defined by files in the PR itself. Examples in the current repositories: `ai-gateway` runs `npm run validate:merge` and `npm run check:deploy` (defined in the PR's `package.json`), `internal-vault` runs `python -m ruff check .` (configured by the PR's `ruff.toml`), `delta-suite` runs `ruff check advanced scripts --select ...` (flags fixed in the script, so fine) and `delta`/`app-source` call `cargo` with fixed flags (the PR's `Cargo.toml` and lint attributes still apply).
- The code runs in the sandbox without central secrets, so this is not a secret-exposure issue. It is an **evidence integrity** issue: a PR can weaken its own checks (edit the `validate:merge` script to `exit 0`, relax `ruff.toml`) and still produce `validate-merge=success`.
- Where tests live centrally (the `tests/packs/<repo>` packs) this is already closed for the tests themselves.

## 选项

| | Idea | Closes the gap | Cost |
|---|---|---|---|
| A | The control script (base ref, trusted) calls standard tools directly with fixed arguments instead of `npm run <script>` | For the commands moved. The tool configuration files (`biome.jsonc`, `ruff.toml`, `tsconfig.json`) are still PR-controlled. In `ai-gateway`, `validate:merge` mostly runs **repository-owned scripts** (`scripts/check-syntax.mjs`, `secret-scan.mjs`, `docs-check.mjs`, `link-check.mjs`, `deployment-config-check.mjs`, `migrations-check.mjs`, `test.mjs`) and only `biome` and `tsc` are standard tools, so A alone closes little there | One edit per repository's `central-ci.sh`; keeping the script and the package scripts in sync |
| B | Add the files that define checks to `CONTROL_PATHS`: `package.json`, `package-lock.json`, lint and type-check configs, `Cargo.toml` lint tables, `ruff.toml` | Changes to them become "control changes" and are only accepted from trusted same-repository maintainers | **Dependabot impact**: Dependabot PRs have author association `CONTRIBUTOR`, not trusted, and always touch `package.json`/lock files. They would be rejected with "CI control changes require a trusted same-repository maintainer PR". Lock file bumps by maintainers would also switch to head-ref CI each time |
| C | Keep as is and document that PR-controlled scripts and configs can weaken the checks | None | None; relies on human review and on `CODEOWNERS` for `package.json`/configs |

## 推荐

**A for standard tools (`biome`, `tsc`, `ruff`, `cargo`), C for configuration files and for repository-owned check scripts, plus CODEOWNERS (done in the ORG-009 PRs) for review.** Actually closing the gap for `ai-gateway` means moving its check scripts into centrally owned code (for example `tests/packs/ai-gateway` or an action-worker script that runs against the checkout); that is a larger project and I recommend scoping it separately rather than bundling it here. Do not do B for `package.json`/lock files: it breaks Dependabot and adds friction for every dependency update. If B is wanted later, apply it only to lint/type-check configuration and keep dependency manifests out; that needs a separate decision.

Migration steps once approved:
1. In each repository whose `central-ci.sh` calls `npm run <script>` (today: `ai-gateway`), replace the calls to standard tools with direct commands and fixed flags (`npx biome check .`, `npx tsc --noEmit`); keep the npm scripts for developers. Repository-owned scripts stay as they are until the separate project above.
2. Add a test in `tests/packs/<repo>` that fails if `central-ci.sh` calls `npm run`.
3. Document in `docs/INTEGRATION_GUIDE.md` that the control script must not execute commands defined in PR-controlled files, and which configuration files remain PR-controlled.

## 影响

- No change to Dependabot flow with A or C.
- Among the repositories surveyed, only `ai-gateway`'s control script calls `npm run`; the others already call their tools directly, so A is one repository plus the pack test. That PR edits a control file, so its CI runs from its head ref and needs a trusted same-repository author.
- Honest limit: after A, `ai-gateway` still runs its own check scripts from the PR; the gap there is only closed by the separate centralisation project.
- Not covered by any option: a PR that edits `ruff.toml` or `tsconfig.json` to relax a rule. Reviewers (CODEOWNERS) are the control there.
