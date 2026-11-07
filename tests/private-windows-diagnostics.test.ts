import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sandbox = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
const dispatch = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");

test("private Windows diagnostics emit only strictly bounded numerical indices", () => {
  assert.match(sandbox, /value: \$\{\{ jobs\.windows\.outputs\.windows_diagnostic \}\}/);
  assert.match(
    sandbox,
    /windows_diagnostic: \$\{\{ steps\.private_diag\.outputs\.windows_diagnostic \}\}/
  );
  assert.match(
    sandbox,
    /if: always\(\) && inputs\.is_private == 'true' && inputs\.private_windows_numeric_diagnostic == 'true'/
  );
  assert.doesNotMatch(sandbox, /inputs\.repository == 'fongap-labs\/app-source'/);
  assert.match(
    dispatch,
    /private_windows_numeric_diagnostic: \$\{\{ needs\.prepare\.outputs\.private_windows_numeric_diagnostic \}\}/
  );
  assert.match(dispatch, /IS_PRIVATE: \$\{\{ steps\.visibility\.outputs\.is_private \}\}/);
  assert.match(sandbox, /WC_TEST_FAIL_INDEX=\(\[1-9\]\[0-9\]\{0,2\}\)/);
  assert.match(sandbox, /windows_diagnostic=wc-tests-/);
  assert.match(sandbox, /Select-Object -First 5/);
  assert.doesNotMatch(sandbox, /Get-Content \$log\s*(?:\r?\n)\s*Write-Host/);
});

test("CI Evidence stays fail-closed while including numeric-only private diagnostics", () => {
  assert.match(
    dispatch,
    /WINDOWS_DIAGNOSTIC: \$\{\{ needs\.windows\.outputs\.windows_diagnostic \|\| '' \}\}/
  );
  assert.match(dispatch, /WINDOWS_RESULT" == "failure" && "\$WINDOWS_DIAGNOSTIC" =~ \^wc-tests-/);
  assert.match(dispatch, /description="Windows regression failed cases /);
  assert.match(
    dispatch,
    /node scripts\/write-commit-status\.ts "\$REPOSITORY" "\$HEAD_SHA" "\$state"/
  );
  assert.match(
    dispatch,
    /\[\[ "\$WINDOWS_RESULT" == "success" \|\| "\$WINDOWS_RESULT" == "skipped" \]\]/
  );
  assert.doesNotMatch(dispatch, /state=success[\s\S]*?WINDOWS_DIAGNOSTIC[\s\S]*?state=success/);
});
