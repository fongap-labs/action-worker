// Centrally owned regression cases migrated from Delta PR #97.
// Executed only in the existing public-source CI sandbox, never on a privileged runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const target = realpathSync(process.argv[2]);
const contract = realpathSync(join(target, "scripts/design-token-contract.ts"));
const within = relative(target, contract);
assert.ok(within && within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within),
  "Design token contract must remain inside the candidate checkout");
const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
assert.equal(manifest.scripts?.["verify-design-token-contract"], "tsx scripts/design-token-contract.ts");
const { designTokenProblems } = await import(pathToFileURL(contract).href);
assert.equal(typeof designTokenProblems, "function");

const valid = {
  "packages/client/ui-theme/src/styles/base.css": ":root { --dsw-radius-sm: 8px; }",
  "packages/client/ui-theme/src/styles/palette.css":
    "body { --dsw-static-brand: #123456; --dsw-alias-brand: var(--dsw-static-brand); } body[data-dark] { --dsw-static-brand: #abcdef; }",
  "packages/client/ui-panel/src/Panel.module.css":
    ".panel { --dsw-elevation-stroke-color: var(--dsw-alias-brand); color: var(--dsw-alias-brand); border-radius: var(--dsw-radius-sm); }",
};
assert.deepEqual(designTokenProblems(Object.keys(valid), (file) => valid[file]), []);

const invalid = {
  "packages/client/ui-theme/src/styles/a.css": ":root { --dsw-alias-a: var(--dsw-alias-b); }",
  "packages/client/ui-theme/src/styles/b.css": ":root { --dsw-alias-b: var(--dsw-alias-a); }",
  "packages/client/ui-panel/src/Panel.module.css":
    ".panel { --dsw-alias-a: red; color: var(--dsw-alias-missing); }",
};
assert.deepEqual(designTokenProblems(Object.keys(invalid), (file) => invalid[file]), [
  "--dsw-alias-a is defined in multiple files: packages/client/ui-theme/src/styles/a.css, packages/client/ui-panel/src/Panel.module.css",
  "packages/client/ui-panel/src/Panel.module.css: --dsw-alias-a is outside the ui-theme authority",
  "packages/client/ui-panel/src/Panel.module.css: references undefined token --dsw-alias-missing",
  "token reference cycle: --dsw-alias-a -> --dsw-alias-b -> --dsw-alias-a",
]);

// Execute the full source/catalog check, not only the synthetic fixtures.
const result = spawnSync(process.execPath, ["--experimental-strip-types", contract], {
  cwd: target,
  stdio: "inherit",
  timeout: 60_000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, "Candidate design token catalog and source must pass");
console.log("Central Delta design token contract: fixtures and full source/catalog passed.");
