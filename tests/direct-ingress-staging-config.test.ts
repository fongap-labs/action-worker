import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildDirectIngressStagingConfig,
  directIngressStagingConfigPath,
} from "../scripts/build-direct-ingress-staging-config.ts";

const approved = {
  databaseName: "aw-direct-ingress-staging",
  databaseId: "12345678-1234-4123-8123-123456789abc",
  appId: "42",
  installationId: "101",
};

test("staging config is inert and has no public route, preview URL, cron or inline secrets", () => {
  const config = buildDirectIngressStagingConfig(approved);
  assert.equal(directIngressStagingConfigPath, ".direct-ingress-staging.wrangler.json");
  assert.equal(config.name, "action-worker-direct-ingress-staging");
  assert.equal(config.main, "scripts/direct-event-ingress.ts");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.triggers.crons, []);
  assert.deepEqual(config.d1_databases, [
    {
      binding: "AW_INGRESS_DB",
      database_name: approved.databaseName,
      database_id: approved.databaseId,
    },
  ]);
  assert.deepEqual(config.vars, {
    AW_CONTROL_REPOSITORY: "fongap-labs/action-worker",
    AW_GITHUB_APP_ID: "42",
    AW_GITHUB_APP_INSTALLATION_ID: "101",
  });
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes("AW_GITHUB_APP_PRIVATE_KEY"), false);
  assert.equal(serialized.includes("AW_GITHUB_WEBHOOK_SECRET"), false);
  assert.equal(serialized.includes("api_token"), false);
  assert.equal("account_id" in config, false);
});

test("staging generator rejects missing or malformed IDs before writing configuration", () => {
  for (const changes of [
    { databaseName: "" },
    { databaseName: "production/example" },
    { databaseId: "" },
    { databaseId: "not-a-d1-uuid" },
    { appId: "" },
    { appId: "0" },
    { appId: "1.2" },
    { installationId: "" },
    { installationId: "-3" },
    { installationId: "abc" },
  ]) {
    assert.throws(
      () => buildDirectIngressStagingConfig({ ...approved, ...changes }),
      /Approved staging D1 and GitHub App identifiers are required/
    );
  }
});

test("central static CI verifies the inert ingress Worker through a pinned Wrangler dry-run", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/validate-ci.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /Dry-run direct ingress Worker bundle/);
  assert.match(workflow, /npm run ingress:staging-config/);
  assert.match(workflow, /wrangler@4\\.158\\.0 deploy --dry-run/);
  assert.match(workflow, /--config \\.direct-ingress-staging\\.wrangler\\.json/);
  assert.match(workflow, /--outdir/);
  assert.doesNotMatch(workflow, /wrangler@4\\.158\\.0 deploy --config/);
});
