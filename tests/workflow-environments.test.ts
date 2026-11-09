import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

type Workflow = {
  jobs?: Record<string, { environment?: string | { name?: unknown; deployment?: unknown } }>;
};

test("operations environments never create GitHub Deployment records", async () => {
  const directory = ".github/workflows";
  const filenames = await readdir(directory);

  for (const filename of filenames.filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = parse(await readFile(join(directory, filename), "utf8")) as Workflow;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const environment = job.environment;
      const name = typeof environment === "string" ? environment : environment?.name;
      if (typeof name !== "string" || !name.endsWith("-ops")) continue;
      assert.ok(environment && typeof environment === "object");
      assert.equal(
        environment.deployment,
        false,
        `${filename}:${jobName} (${name}) must disable Deployment records`
      );
    }
  }
});

test("actual central deployments remain tracked under production", async () => {
  const workflow = parse(
    await readFile(".github/workflows/deploy-source-script.yml", "utf8")
  ) as Workflow;
  assert.deepEqual(workflow.jobs?.deploy?.environment, {
    name: "${{ needs.prepare.outputs.credential_environment }}",
    deployment: "${{ needs.prepare.outputs.create_deployment == 'true' }}",
  });
  assert.deepEqual(workflow.jobs?.record_production_deployment?.environment, {
    name: "${{ needs.prepare.outputs.environment }}",
  });

  const policy = JSON.parse(await readFile("policies/deploy-environments.json", "utf8")) as {
    repositories: Record<string, string[]>;
  };
  for (const allowed of Object.values(policy.repositories)) {
    assert.deepEqual(allowed, ["production"]);
  }
});
