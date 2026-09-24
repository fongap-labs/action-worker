import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/aig-deploy.yml", import.meta.url), "utf8");

test("AI Gateway deploy binds the validated business source identity", () => {
  assert.match(workflow, /echo "AIG_BUILD_SHA=\$SOURCE_SHA"/);
  assert.doesNotMatch(workflow, /echo "GITHUB_SHA=\$SOURCE_SHA"/);
  assert.match(workflow, /--expected-build "\$DEPLOYED_SHA"/);
});
