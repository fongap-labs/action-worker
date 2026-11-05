import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

test("live workflows and scripts use only the three-part status keyring name", async () => {
  for (const directory of [".github/workflows", "scripts"]) {
    const files = (await readdir(directory)).filter(
      (file) => file.endsWith(".yml") || file.endsWith(".ts")
    );
    for (const file of files) {
      const source = await readFile(`${directory}/${file}`, "utf8");
      assert.doesNotMatch(
        source,
        /AW_STATUS_SIGNING_KEYS/,
        `${directory}/${file} must not reference the retired signing secret`
      );
    }
  }
  const signing = await readFile("scripts/status-attestation.ts", "utf8");
  assert.match(signing, /process\.env\.AW_STATUS_KEYRING/);
  const initializer = await readFile("scripts/bootstrap-status-signing.ts", "utf8");
  assert.match(initializer, /gh", \["secret", "set", "AW_STATUS_KEYRING"/);
});
