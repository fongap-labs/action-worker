import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractProductsFromPaths,
  formatGapHint,
  hasProductPolicyKey,
  parsePullRequestFiles,
  productPolicyKey,
} from "../scripts/check-deploy-gap.ts";

test("the paginated file response is read as one array per page", () => {
  const response = JSON.stringify([
    [{ filename: "projects/alpha/deploy.json" }, { filename: "README.md" }],
    [{ filename: "src/index.ts" }],
  ]);
  assert.deepEqual(parsePullRequestFiles(response), [
    "projects/alpha/deploy.json",
    "README.md",
    "src/index.ts",
  ]);
});

test("a single page response is read as one array", () => {
  const response = JSON.stringify([[{ filename: "projects/beta/deploy.json" }]]);
  assert.deepEqual(parsePullRequestFiles(response), ["projects/beta/deploy.json"]);
});

test("a response without files names no file", () => {
  assert.deepEqual(parsePullRequestFiles("[]"), []);
});

test("only products under projects/ need a central policy entry", () => {
  const products = extractProductsFromPaths([
    "projects/alpha/deploy.json",
    "projects/alpha/release.manifest.json",
    "projects/beta/deploy.json",
    ".github/deploy.json",
    ".github/release.manifest.json",
    "projects/alpha/src/index.ts",
    "projects/alpha/nested/deploy.json",
  ]);
  assert.deepEqual([...products].sort(), ["alpha", "beta"]);
});

test("a pull request without product manifests needs no check", () => {
  assert.deepEqual([...extractProductsFromPaths(["README.md", "src/main.ts"])], []);
});

test("a directory name that is not a product name is not a product", () => {
  const products = extractProductsFromPaths([
    "projects/with space/deploy.json",
    "projects/../escape/deploy.json",
    "projects/-leading-dash/deploy.json",
  ]);
  assert.deepEqual([...products], []);
});

test("a product name follows the central naming rule", () => {
  const products = extractProductsFromPaths([
    "projects/alpha/deploy.json",
    "projects/Alpha.Beta-2/deploy.json",
  ]);
  assert.deepEqual([...products].sort(), ["Alpha.Beta-2", "alpha"]);
});

test("a product key is the repository key plus the product name", () => {
  assert.equal(productPolicyKey("fongap-labs/ai-gateway", "alpha"), "fongap-labs/ai-gateway/alpha");
});

test("a repository key never counts as a product key", () => {
  const keys = ["fongap-labs/ai-gateway"];
  assert.equal(hasProductPolicyKey(keys, "fongap-labs/ai-gateway", "ai-gateway"), false);
  assert.equal(hasProductPolicyKey(keys, "fongap-labs/ai-gateway", "alpha"), false);
});

test("a product of another repository never counts as this product", () => {
  const keys = ["fongap-labs/internal-vault/alpha"];
  assert.equal(hasProductPolicyKey(keys, "fongap-labs/ai-gateway", "alpha"), false);
  assert.equal(hasProductPolicyKey(keys, "fongap-labs/internal-vault", "alpha"), true);
});

test("the hint names the central files that need an entry", () => {
  const hint = formatGapHint([
    { product: "alpha", missing: ["deploy-environments.json", "deploy-secrets.json"] },
  ]);
  assert.match(hint, /### Deploy Configuration Gaps/);
  assert.match(hint, /`alpha`/);
  assert.match(hint, /policies\/deploy-environments\.json/);
  assert.match(hint, /policies\/deploy-secrets\.json/);
});

test("no gap produces no hint", () => {
  assert.equal(formatGapHint([]), "");
});
