import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubHttpError } from "../scripts/github-api.ts";
import { assertExistingCredentialEnvironment } from "../scripts/verify-deploy-credential-environment.ts";

const repository = "fongap-labs/action-worker";

test("ops Environment existence check permits existing manual reviewer rules", async () => {
  const paths: string[] = [];
  await assertExistingCredentialEnvironment(
    {
      async get(path) {
        paths.push(path);
        return { name: "internal-vault-ops", protection_rules: [{ type: "required_reviewers" }] };
      },
    },
    repository,
    "internal-vault-ops"
  );
  assert.deepEqual(paths, ["repos/fongap-labs/action-worker/environments/internal-vault-ops"]);
});

test("missing and unreadable credential Environments fail closed", async () => {
  for (const status of [403, 404, 500]) {
    await assert.rejects(
      assertExistingCredentialEnvironment(
        {
          async get() {
            throw new GithubHttpError(status);
          },
        },
        repository,
        "internal-vault-ops"
      ),
      status === 404 ? /does not exist/ : /cannot be verified/
    );
  }
});

test("metadata mismatch and invalid environment identifiers are rejected", async () => {
  for (const value of [
    null,
    {},
    { name: "production", protection_rules: [] },
    { name: "internal-vault-ops" },
    { name: "internal-vault-ops", protection_rules: "none" },
  ]) {
    await assert.rejects(
      assertExistingCredentialEnvironment(
        {
          async get() {
            return value;
          },
        },
        repository,
        "internal-vault-ops"
      ),
      /metadata is invalid/
    );
  }
  for (const environment of ["", "../production", "production/secrets", "UPPERCASE"]) {
    await assert.rejects(
      assertExistingCredentialEnvironment(
        {
          async get() {
            throw new Error("must not fetch");
          },
        },
        repository,
        environment
      ),
      /arguments are invalid/
    );
  }
  await assert.rejects(
    assertExistingCredentialEnvironment(
      {
          async get() {
            throw new Error("must not fetch");
          },
        },
      "fongap-labs/internal-vault",
      "production"
    ),
    /arguments are invalid/
  );
});

test("a known default production Environment remains supported", async () => {
  await assert.doesNotReject(
    assertExistingCredentialEnvironment(
      {
          async get() {
            return { name: "production", protection_rules: [] };
          },
        },
      repository,
      "production"
    )
  );
});
