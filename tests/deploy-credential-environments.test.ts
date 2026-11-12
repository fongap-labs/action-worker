import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { selectDeployCredentialEnvironment } from "../scripts/select-deploy-credential-environment.ts";

const routes = JSON.parse(readFileSync("policies/deploy-credential-environments.json", "utf8"));
const grants = JSON.parse(readFileSync("policies/deploy-environments.json", "utf8"))
  .repositories as Record<string, string[]>;

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
  assert.deepEqual(
    selectDeployCredentialEnvironment(routes, grants, "fongap-labs/ai-gateway", "", "production"),
    { credential_environment: "ai-gateway-ops", create_deployment: false }
  );
  assert.deepEqual(
    selectDeployCredentialEnvironment(routes, grants, "fongap-labs/mcp-hub", "", "production"),
    { credential_environment: "mcp-hub-ops", create_deployment: false }
  );
  for (const [repo, product] of [["fongap-labs/internal-vault", "server-edge"]] as const) {
    assert.deepEqual(
      selectDeployCredentialEnvironment(routes, grants, repo, product, "production"),
      {
        credential_environment: "production",
        create_deployment: true,
      }
    );
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

// Route metadata is not the final Deployment gate: the workflow expression also
// checks the resolved target environment before creating any Deployment record.
test("future non-production deploy targets are restricted by the workflow gate", () => {
  const extendedGrants = {
    ...grants,
    "fongap-labs/mcp-hub": ["production", "staging", "dev", "mcp-hub-ops"],
  };
  for (const environment of ["staging", "dev", "mcp-hub-ops"]) {
    assert.deepEqual(
      selectDeployCredentialEnvironment(
        routes,
        extendedGrants,
        "fongap-labs/mcp-hub",
        "",
        environment
      ),
      { credential_environment: environment, create_deployment: true }
    );
  }
});

test("credential routes fail closed for unauthorized policy edits and cross-owner ops access", () => {
  for (const bad of [
    null,
    {},
    { schema_version: 2, routes: {} },
    { schema_version: 1, routes: { "fongap-labs/other": { production: "internal-vault-ops" } } },
    {
      schema_version: 1,
      routes: { "fongap-labs/internal-vault/FongapCDN": { staging: "internal-vault-ops" } },
    },
    {
      schema_version: 1,
      routes: { "fongap-labs/internal-vault/FongapCDN": { production: "production" } },
    },
    {
      schema_version: 1,
      routes: { "fongap-labs/internal-vault/FongapCDN": { production: "../ops" } },
    },
    {
      schema_version: 1,
      routes: {
        "fongap-labs/internal-vault/FongapCDN": { production: "shared-ops" },
        "fongap-labs/ai-gateway": { production: "shared-ops" },
      },
    },
    {
      schema_version: 1,
      routes: {
        "fongap-labs/ai-gateway": { production: "ai-gateway-ops" },
        "fongap-labs/mcp-hub": { production: "ai-gateway-ops" },
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
  const verifyAt = prepare.steps?.findIndex(
    (step) => step.name === "Verify credential Environment exists before deploy"
  );
  assert.ok(verifyAt !== undefined && verifyAt > credentialsAt);
  assert.equal(
    prepare.steps?.[verifyAt!]?.run,
    "node scripts/verify-deploy-credential-environment.ts"
  );
  assert.deepEqual(prepare.steps?.[verifyAt!]?.env, {
    GH_TOKEN: "${{ github.token }}",
    DEPLOY_CREDENTIAL_ENVIRONMENT: "${{ steps.credentials.outputs.credential_environment }}",
    AW_CONTROL_REPOSITORY: "${{ github.repository }}",
  });
  assert.doesNotMatch(JSON.stringify(prepare.steps?.[verifyAt!]), /secrets\.|AW_APP_PRIVATE_KEY/);
  assert.deepEqual(deploy.environment, {
    name: "${{ needs.prepare.outputs.credential_environment }}",
    deployment:
      "${{ needs.prepare.outputs.create_deployment == 'true' && needs.prepare.outputs.environment == 'production' }}",
  });
  assert.deepEqual(record.needs, ["prepare", "deploy"]);
  // The protected ops deployment already occurred; production audit is not
  // another Environment approval gate.
  assert.equal(record.environment, undefined);
  assert.match(record.if ?? "", /github\.ref == 'refs\/heads\/main'/);
  assert.match(record.if ?? "", /needs\.deploy\.result == 'success'/);
  assert.match(record.if ?? "", /credential_environment != needs\.prepare\.outputs\.environment/);
  assert.deepEqual(record.permissions, { contents: "read", deployments: "write" });
  const audit = record.steps?.[0];
  assert.equal(audit?.env?.GH_TOKEN, "${{ github.token }}");
  assert.equal(audit?.env?.TARGET_ENVIRONMENT, "${{ needs.prepare.outputs.environment }}");
  assert.match(audit?.run ?? "", /\[\[ "\$SOURCE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(audit?.run ?? "", /auto_merge:false,required_contexts:\[\]/);
  assert.match(audit?.run ?? "", /payload:\{source_repository:/);
  assert.match(audit?.run ?? "", /gh api --method POST .*\/deployments"/);
  assert.match(audit?.run ?? "", /gh api --method POST .*\/statuses"/);
  assert.match(audit?.run ?? "", /state:"success"/);
  assert.doesNotMatch(
    JSON.stringify(record),
    /secrets\.|AW_DEPLOY_SECRET_|AW_ADMIN_TOKEN|CLOUDFLARE_API_TOKEN/
  );
});
