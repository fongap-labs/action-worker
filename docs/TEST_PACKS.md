# Test Packs

Managed business repositories no longer keep their own test suites. Action Worker holds each business repository's tests as a **test pack** in `tests/packs/<pack>/`, and central CI runs it against the checked-out source of the target repository.

## 1. Why tests are central

- **A PR cannot weaken its own tests.** A business repository's `tests/` and `package.json` scripts are within reach of the PR author; a pack comes from a trusted ref, so a PR can only be checked by it, never rewrite it.
- **Reusable building blocks.** `tests/kit/` provides a shared harness, target lookup, fetch / time / contract assertions and other building blocks, so a business suite only writes assertions.
- **Governed in one place.** The test inventory, gate tiers, runner parallelism and reporting are all maintained by Action Worker.

## 2. Layout

```text
tests/
  kit/               shared building blocks (harness, target, fetch, time, contract, mock-d1, python/kit_target.py)
  run-pack.mjs       pack runner: node tests/run-pack.mjs <pack> <absolute target_root> [unit|gate|all]
  packs/<pack>/      one pack per business repository (pack.json + suites)
  inventory/         pre-migration baseline inventories (may only grow)
```

## 3. Execution contract

| Item | Description |
|---|---|
| Test source | Action Worker (a trusted ref, or a historical commit pinned by `.github/test-pack.json`) |
| Code under test | `CENTRAL_TEST_TARGET_ROOT` (the checkout of the PR head), read-only and imported only |
| JS suites | `import … from '#target/<path>'` imports target source; `#kit/*` imports building blocks |
| Python suites | `from kit_target import target_root`; `PYTHONPATH` contains the target repository and `tests/kit/python` |
| Trust domain | `sandbox`: `execute_pr_code: true`, `allow_secrets: false` (see `policies/execution.json`) |
| Entry point | the business repository's `central-ci.sh` calls `node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" <pack> "$TARGET_ROOT"` |

`central-ci-sandbox.yml` checks Action Worker out to `aw/` in the Linux and Windows jobs and exports `CENTRAL_CI_AW_ROOT`.

## 4. Version pinning

The business repository's `.github/test-pack.json`:

```json
{ "schema_version": 1, "pack": "ai-gateway", "ref": "main" }
```

- `ref` can only be `main` or a full commit SHA; a SHA must be an ancestor in Action Worker's trusted history (checked by `scripts/prepare-test-pack.ts`).
- The file is a **CI control path** (like `execution-manifest.json` and `central-ci.sh`): changing it needs a PR from a trusted same-repository maintainer, and that PR is verified against its own head.
- A behaviour change (`breaking` / `api` / `migration`) uses a paired flow: merge the pack change in Action Worker first, then pin the business PR to that commit.

## 5. Test inventory (no test is lost)

`tests/inventory/<pack>.baseline.json` is the list of test cases collected **before migration** by running the suites in their original place in the business repository.

```bash
# Collect the current pack (node)
node tests/kit/inventory.mjs collect --dir tests/packs/ai-gateway --cwd <target> \
  --preload tests/kit/register-target.mjs --target <target> --out current.json
# Collect the current pack (python)
node tests/kit/inventory.mjs collect-python --dir tests/packs/delta \
  --config tests/packs/delta/pytest.ini --cwd <target> --target <target> --run --out current.json
# Reconcile: every case in the baseline must still exist and pass
node tests/kit/inventory.mjs verify --baseline tests/inventory/<pack>.baseline.json --current current.json
```

Merging or renaming files does not cause a failure; deleting or reducing test cases needs an explicit, reviewed change to the baseline.

## 6. Tests that stay in the business repository

Rule: a test stays only when it cannot reach the object under test from outside through `TARGET_ROOT`.

- Rust inline `#[cfg(test)]` tests and in-crate integration tests (they depend on crate-private items and the Cargo build graph).
- Desktop Playwright e2e and vitest component tests (they depend on the `apps/desktop` toolchain).
- Infrastructure script tests that need root or Docker (such as `internal-vault/services/server-edge/tests/*.sh`).
- `delta-suite/tests/foundation_runtime_e2e` (compiled into the pinned Foundation core crate).
- `app-source/projects/SecurePigeon/crates/*/tests` (Rust crate integration tests and fuzz tests).

## 7. Adding tests

1. Add the suite under `tests/packs/<pack>/`; JS uses `#kit/harness.mjs` (`node:test`), Python uses pytest.
2. Do not reimplement `test()`, `dateAtIso()` or fetch mocks in a suite; use the building blocks in `tests/kit/`, and add a missing building block there first.
3. Keep suites that need time or global-state isolation in their own files (for example cases that depend on real timing).
4. Gate-tier suites are registered under `tiers.gate` in `pack.json`; all other suites are discovered from disk and need no registration.

## 8. Status per repository

| Repository | Pack | Tests that stay in the business repository |
|---|---|---|
| ai-gateway | `ai-gateway` (24 modules) | none |
| delta | `delta` (6 modules) | Rust inline and crate tests, `apps/desktop` e2e and vitest, tests inside 3 small packages such as `packages/delta_worker_sdk` |
| delta-suite | `delta-suite` (4 modules) | `tests/foundation_runtime_e2e` |
| internal-vault | `internal-vault` (8 modules) | `services/server-edge/tests/*.sh` (need root and Docker) |
| app-source | `app-source` (1 module, the database tests of license-service) | `crates/*/tests` (Rust); `legacy/test_*.py` are legacy scripts CI never runs and are not part of the pack |
| external-vault | none | no test suite; CI runs only the manifest and secret scan check scripts |
| AssHub | none | empty repository |
