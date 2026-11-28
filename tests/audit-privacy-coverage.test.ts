import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readInstallationInventory,
  summarizePrivacyCoverage,
} from "../scripts/audit-privacy-coverage.ts";

const policy = {
  schema_version: 1,
  organization: "example",
  grants: { "example/public": ["pr"], "example/private": ["pr"] },
  excluded_repositories: ["example/legacy"],
};
const repo = (name: string, isPrivate: boolean, archived = false) => ({
  full_name: `example/${name}`,
  owner: { login: "example" },
  private: isPrivate,
  archived,
});

test("coverage inventory separates public, private, excluded and unmanaged repos", () => {
  const summary = summarizePrivacyCoverage(policy, [
    repo("public", false),
    repo("private", true),
    repo("legacy", true, true),
    repo("new", true),
  ]);
  assert.equal(summary.inventory_repositories, 4);
  assert.equal(summary.inventory_public, 1);
  assert.equal(summary.inventory_private, 3);
  assert.equal(summary.active_policy_referenced, 2);
  assert.equal(summary.archived_repositories, 1);
  assert.equal(summary.excluded_repositories, 1);
  assert.equal(summary.active_unmanaged, 1);
  assert.equal(summary.enforcement_verified, false);
  assert.equal(summary.scanned_source_files, false);
  assert.equal(summary.automatic_writes, false);
});

test("unknown metadata, wrong owners and duplicate entries are rejected", () => {
  assert.throws(() =>
    summarizePrivacyCoverage(policy, [repo("public", false), repo("public", false)])
  );
  assert.throws(() =>
    summarizePrivacyCoverage(policy, [{ ...repo("private", true), archived: undefined }])
  );
  assert.throws(() =>
    summarizePrivacyCoverage(policy, [{ ...repo("other", true), owner: { login: "other" } }])
  );
  assert.throws(() => summarizePrivacyCoverage({}, []));
});

test("unavailable or partial installation inventory never counts as full coverage", async () => {
  const reader = {
    get: async () => ({ repositories: null }),
  };
  await assert.rejects(() => readInstallationInventory(reader));
});

test("coverage summary never includes repository names or credential metadata", () => {
  const result = summarizePrivacyCoverage(policy, [repo("private", true)]);
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /example\/private|example\/public|token|secret/i);
  assert.equal(result.policy_references_outside_installation, 1);
});

test("organization audit workflow uses a scoped installation token and does not publish private identifiers", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(".github/workflows/audit-config-scope.yml", "utf8")
  );
  assert.match(source, /- name: Mint organization inventory read token/);
  assert.match(source, /permission-contents: read/);
  assert.match(source, /node scripts\/audit-privacy-coverage\.ts/);
  const audit = source.slice(source.indexOf("  audit:"), source.indexOf("  discover-proposals:"));
  const discovery = source.slice(
    source.indexOf("  discover-proposals:"),
    source.indexOf("  propose-dependencies:")
  );
  assert.ok(audit.length > 0 && discovery.length > 0);
  for (const lane of [audit, discovery]) {
    assert.doesNotMatch(lane, /permission-contents: write|permission-pull-requests: write/);
    assert.doesNotMatch(lane, /propose-dependency-update\.ts publish/);
  }
  const privateLane = source.slice(source.indexOf("  private-proposals:"));
  assert.ok(privateLane.length > 0);
  assert.doesNotMatch(privateLane, /upload-artifact|download-artifact|matrix\.|\$\{\{ matrix/);
  assert.match(privateLane, /propose-dependency-update\.ts "\$PROPOSAL_MODE"/);
  assert.match(privateLane, /inputs\.sync_agent_guides && 'guides' \|\| 'private'/);
  assert.match(privateLane, /inputs\.confirm && secrets\.AW_APP_PRIVATE_KEY/);
  assert.equal(source.match(/permission-contents: write/g)?.length, 1);
  assert.equal(source.match(/permission-pull-requests: write/g)?.length, 1);
});
