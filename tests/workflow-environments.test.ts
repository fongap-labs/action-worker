import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

type Workflow = {
  jobs?: Record<string, { environment?: string | { name?: unknown; deployment?: unknown } }>;
};

test("non-production environments never create GitHub Deployment records", async () => {
  const directory = ".github/workflows";
  const filenames = await readdir(directory);

  for (const filename of filenames.filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = parse(await readFile(join(directory, filename), "utf8")) as Workflow;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const environment = job.environment;
      if (environment === undefined) continue;
      const name = typeof environment === "string" ? environment : environment.name;
      assert.ok(typeof name === "string", `${filename}:${jobName} must name an Environment`);
      if (name === "production") continue;
      // Dynamic Environment names are denied unless the centralized source-deploy
      // selector controls both the name and the production-only deployment flag.
      if (name === "${{ needs.prepare.outputs.credential_environment }}") {
        assert.equal(filename, "deploy-source-script.yml");
        assert.equal(jobName, "deploy");
        assert.deepEqual(environment, {
          name,
          deployment: "${{ needs.prepare.outputs.create_deployment == 'true' }}",
        });
        continue;
      }
      assert.ok(
        !name.includes("${{"),
        `${filename}:${jobName} cannot use an unreviewed dynamic Environment`
      );
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
  // The protected ops job is the authorization boundary. An audit-only
  // production Environment job would require a second human approval after publish.
  assert.equal(workflow.jobs?.record_production_deployment?.environment, undefined);

  const policy = JSON.parse(await readFile("policies/deploy-environments.json", "utf8")) as {
    repositories: Record<string, string[]>;
  };
  for (const allowed of Object.values(policy.repositories)) {
    assert.deepEqual(allowed, ["production"]);
  }
});
