import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { selectDeployCredentialEnvironment } from "../scripts/select-deploy-credential-environment.ts";

const routes = JSON.parse(readFileSync("policies/deploy-credential-environments.json", "utf8"));
const grants = JSON.parse(readFileSync("policies/deploy-environments.json", "utf8")).repositories as Record<
  string,
  string[]
>;

test("only approved source product switches credential ownership to existing ops", () => {
  assert.deepEqual(
    selectDeployCredentialEnvironment(
      routes,
      grants,
      "fongap-labs/internal-vault",
      "FongapCDN",
      "production"
    ),
    { credential_environment: "internal-vault-ops", create_deployment: false }
  );
  for (const [repo, product] of [
    ["fongap-labs/internal-vault", "server-edge"],
    ["fongap-labs/ai-gateway", ""],
    ["fongap-labs/mcp-hub", ""],
  ] as const) {
    assert.deepEqual(selectDeployCredentialEnvironment(routes, grants, repo, product, "production"), {
      credential_environment: "production",
      create_deployment: true,
    });
  }
  for (const [repo, product, environment] of [
    ["fongap-labs/internal-vault", "FongapCDN", "admin-ops"],
    ["fongap-labs/internal-vault", "Unapproved", "production"],
    ["fongap-labs/external-vault", "FongapCDN", "production"],
    ["fongap-labs/internal-vault", "../FongapCDN", "production"],
  ] as const) {
    assert.throws(
      () => selectDeployCredentialEnvironment(routes, grants, repo, product, environment),
      /not authorized/
    );
  }
});

test("credential routes fail closed for unauthorized policy edits and cross-owner ops access", () => {
  for (const bad of [
    null,
    {},
    { schema_version: 2, routes: {} },
    { schema_version: 1, routes: { "fongap-labs/other": { production: "internal-vault-ops" } } },
    { schema_version: 1, routes: { "fongap-labs/internal-vault/FongapCDN": { staging: "internal-vault-ops" } } },
    { schema_version: 1, routes: { "fongap-labs/internal-vault/FongapCDN": { production: "production" } } },
    { schema_version: 1, routes: { "fongap-labs/internal-vault/FongapCDN": { production: "../ops" } } },
    {
      schema_version: 1,
      routes: {
        "fongap-labs/internal-vault/FongapCDN": { production: "shared-ops" },
        "fongap-labs/ai-gateway": { production: "shared-ops" },
      },
    },
  ]) {
    assert.throws(
      () =>
        selectDeployCredentialEnvironment(
          bad,
          grants,
          "fongap-labs/internal-vault",
          "FongapCDN",
          "production"
        ),
      /invalid|grant|owners/
    );
  }
});

test("central deployment uses ops only for authorized credential read and records production separately", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<
      string,
      {
        if?: string;
        environment?: unknown;
        needs?: string[];
        permissions?: Record<string, string>;
        outputs?: Record<string, string>;
        steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      }
    >;
  };
  const prepare = workflow.jobs.prepare;
  const deploy = workflow.jobs.deploy;
  const record = workflow.jobs.record_production_deployment;
  assert.ok(prepare && deploy && record);
  assert.equal(
    prepare.outputs?.credential_environment,
    "${{ steps.credentials.outputs.credential_environment }}"
  );
  assert.equal(
    prepare.outputs?.create_deployment,
    "${{ steps.credentials.outputs.create_deployment }}"
  );
  const validateAt = prepare.steps?.findIndex((step) => step.name === "Validate deploy source");
  const credentialsAt = prepare.steps?.findIndex(
    (step) => step.name === "Resolve approved credential Environment for deployment"
  );
  assert.ok(validateAt !== undefined && credentialsAt !== undefined && credentialsAt > validateAt);
  const credentialStep = prepare.steps?.[credentialsAt!];
  assert.equal(credentialStep?.run, "node scripts/select-deploy-credential-environment.ts");
  assert.deepEqual(Object.keys(credentialStep?.env ?? {}).sort(), [
    "DEPLOY_ENVIRONMENT",
    "DEPLOY_PRODUCT",
    "DEPLOY_SOURCE_REPOSITORY",
  ]);
  assert.deepEqual(deploy.environment, {
    name: "${{ needs.prepare.outputs.credential_environment }}",
    deployment: "${{ needs.prepare.outputs.create_deployment == 'true' }}",
  });
  assert.deepEqual(record.needs, ["prepare", "deploy"]);
  assert.deepEqual(record.environment, { name: "${{ needs.prepare.outputs.environment }}" });
  assert.match(record.if ?? "", /needs\.deploy\.result == 'success'/);
  assert.match(record.if ?? "", /credential_environment != needs\.prepare\.outputs\.environment/);
  assert.doesNotMatch(JSON.stringify(record), /secrets\.|AW_DEPLOY_SECRET_|AW_ADMIN_TOKEN/);
  assert.deepEqual(record.permissions, { contents: "read" });
});
