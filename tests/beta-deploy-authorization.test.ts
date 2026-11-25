import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  betaDeployCredentialPlan,
  readBetaDeployPolicy,
  resolveBetaDeployTarget,
  selectBetaDeployVariables,
} from "../scripts/beta-deploy-authorization.ts";
import { buildScopedDeployEnvironment } from "../scripts/run-scoped-deploy.ts";
import { selectDeployCredentialEnvironment } from "../scripts/select-deploy-credential-environment.ts";
import { assertExistingCredentialEnvironment } from "../scripts/verify-deploy-credential-environment.ts";

const repository = "fongap-labs/example";
const target = {
  credential_environment: "beta-example-ops",
  credentials: {
    API_TOKEN: { source: "BETA_EXAMPLE_OPS_API_TOKEN", kind: "secret" },
    ACCOUNT_ID: { source: "BETA_EXAMPLE_OPS_ACCOUNT_ID", kind: "variable" },
  },
};
const policy = { schema_version: 1, targets: { [repository]: target } };

test("Beta target is explicitly authorized without fallback to production or another product", () => {
  assert.throws(() => resolveBetaDeployTarget(readBetaDeployPolicy(), repository, ""), /disabled/);
  assert.throws(() => resolveBetaDeployTarget(policy, repository, "other"), /disabled/);
  assert.throws(() =>
    resolveBetaDeployTarget(
      { ...policy, targets: { [repository]: { ...target, credential_environment: "example-ops" } } },
      repository,
      ""
    )
  );
  assert.deepEqual(
    selectDeployCredentialEnvironment({}, {}, repository, "", "beta", policy),
    { credential_environment: "beta-example-ops", create_deployment: false }
  );
  assert.throws(() => selectDeployCredentialEnvironment({}, {}, repository, "", "beta"));
});

test("Beta credentials and variables cannot fall back to a formal binding", () => {
  const selected = resolveBetaDeployTarget(policy, repository, "");
  const variables = selectBetaDeployVariables(selected, {
    BETA_EXAMPLE_OPS_ACCOUNT_ID: "beta-account",
    ACCOUNT_ID: "prod-account",
    API_TOKEN: "prod-token",
    BETA_OTHER_OPS_ACCOUNT_ID: "other-account",
  });
  assert.deepEqual(variables, { BETA_EXAMPLE_OPS_ACCOUNT_ID: "beta-account" });
  const required = new Set(["API_TOKEN", "ACCOUNT_ID"]);
  const plan = betaDeployCredentialPlan(selected, required, new Set(), variables);
  const env = buildScopedDeployEnvironment(
    { DEPLOY_ENVIRONMENT: "beta", DEPLOY_SOURCE_BRANCH: "dev" },
    { schema_version: 1, secrets: plan },
    new Map([["API_TOKEN", "beta-token"]]),
    { ...variables, PRODUCTION_URL: "prod", API_TOKEN: "prod-token" }
  );
  assert.deepEqual(env, {
    DEPLOY_ENVIRONMENT: "beta",
    DEPLOY_SOURCE_BRANCH: "dev",
    ACCOUNT_ID: "beta-account",
    API_TOKEN: "beta-token",
  });
  assert.throws(() => betaDeployCredentialPlan(selected, required, new Set(), {}), /unavailable/);
  assert.throws(
    () => betaDeployCredentialPlan(selected, new Set(["OTHER_TOKEN"]), new Set(), {}),
    /not authorized/
  );
  assert.throws(() =>
    buildScopedDeployEnvironment(
      { DEPLOY_ENVIRONMENT: "production" },
      { schema_version: 1, secrets: plan },
      new Map(),
      variables
    )
  );
});

test("Beta Environment must actually exist and have reviewers", async () => {
  const verify = (rules: unknown[]) =>
    assertExistingCredentialEnvironment(
      {
        async get() {
          return { name: "beta-example-ops", protection_rules: rules };
        },
      },
      "fongap-labs/action-worker",
      "beta-example-ops"
    );
  await assert.rejects(verify([]), /requires configured reviewers/);
  await verify([{ type: "required_reviewers", reviewers: [{ id: 1 }] }]);
});

test("manual Beta dispatch carries its trigger and never starts production audit", () => {
  const workflow = readFileSync(".github/workflows/deploy-source-script.yml", "utf8");
  const manual = workflow
    .split("- name: Resolve manual deploy request")[1]
    ?.split("- name: Mint deploy source CI status token")[0];
  assert.match(manual ?? "", /source_branch: \$source_branch/);
  assert.match(manual ?? "", /trigger: "manual"/);
  assert.match(
    workflow,
    /- name: Attest the source main write\n\s+if: steps\.manual_request\.outputs\.source_branch != 'dev'/
  );
  const audit = workflow.split("  record_production_deployment:")[1];
  assert.match(audit ?? "", /needs\.prepare\.outputs\.environment == 'production'/);
});
