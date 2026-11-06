import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

test("private publication uses a single existing protected publisher, never a second writer", async () => {
  const raw = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(raw) as {
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string[];
        environment?: string;
        permissions?: Record<string, string>;
        outputs?: Record<string, string>;
        env?: Record<string, string>;
        steps?: Array<{
          id?: string;
          if?: string;
          name?: string;
          run?: string;
          uses?: string;
          env?: Record<string, string>;
        }>;
      }
    >;
  };
  const run = workflow.jobs.run_private_isolated;
  const trusted = workflow.jobs.finalize_private_isolated;
  const publisher = workflow.jobs.publish;
  assert.ok(run && trusted && publisher);
  assert.deepEqual(publisher.needs, ["validate", "execute", "finalize_private_isolated"]);
  assert.equal(publisher.environment, "admin-ops");
  assert.match(publisher.if ?? "", /needs\.finalize_private_isolated\.result == 'success'/);
  assert.match(publisher.if ?? "", /needs\.execute\.result == 'success'/);
  assert.match(publisher.if ?? "", /publication_staged == 'true'/);
  assert.match(trusted.outputs?.publication_staged ?? "", /private_publication_confirm/);
  assert.equal(Object.values(run.permissions ?? {}).includes("write"), false);
  assert.equal(Object.values(trusted.permissions ?? {}).includes("write"), false);
  assert.doesNotMatch(JSON.stringify(run), /AW_PUBLICATION_PRIVATE_KEY|AW_APP_PRIVATE_KEY/);
  assert.doesNotMatch(JSON.stringify(trusted), /AW_PUBLICATION_PRIVATE_KEY|mint-app-token/);
  assert.match(JSON.stringify(publisher), /AW_PUBLICATION_PRIVATE_KEY/);

  const steps = run.steps ?? [];
  const byName = (name: string) => steps.find((step) => step.name === name);
  const stage = byName("Prepare private publication staging outside source and state");
  const validate = byName("Validate optional private publication without revealing its target");
  const seal = byName("Seal approved private publication before leaving task Runner");
  const upload = byName("Upload only encrypted approved private publication");
  assert.ok(stage && validate && seal && upload);
  assert.equal(validate.if, "steps.private_bootstrap.outcome == 'success'");
  assert.equal(validate.env?.TASK_SOURCE_PRIVATE, "true");
  assert.match(validate.run ?? "", /validate-task-publication\.ts/);
  assert.match(seal.if ?? "", /private_publication\.outputs\.staged == 'true'/);
  assert.match(seal.run ?? "", /task-publication-envelope\.ts seal/);
  assert.doesNotMatch(upload.uses ?? "", /docker/);
  assert.match(upload.if ?? "", /private_seal_publication\.outcome == 'success'/);
  assert.match(upload.env?.AW_PUBLICATION_PRIVATE_KEY ?? "", /^$/);
  assert.match(
    run.outputs?.publication_staged ?? "",
    /private_upload_publication\.outcome == 'success'/
  );
  assert.match(run.outputs?.publication_failed ?? "", /private_publication\.outcome == 'failure'/);

  const finalSteps = trusted.steps ?? [];
  const findFinal = (name: string) => finalSteps.find((step) => step.name === name);
  const rejection = findFinal("Reject failed private publication after preserving diagnostics");
  const confirmation = findFinal("Verify encrypted publication artifact without decrypting");
  assert.ok(rejection && confirmation);
  assert.match(rejection.if ?? "", /publication_failed == 'true'/);
  assert.match(rejection.run ?? "", /exit 66/);
  assert.match(confirmation.run ?? "", /staged=true/);
  assert.ok(
    finalSteps.findIndex((step) => step.name === "Upload encrypted private diagnostic log") <
      finalSteps.findIndex(
        (step) => step.name === "Reject failed private publication after preserving diagnostics"
      )
  );
});

test("private untrusted publisher manifest symlinks fail closed without reading host files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-private-publish-symlink-"));
  try {
    const staged = join(root, "action-worker-publication");
    await mkdir(join(staged, "payload"), { recursive: true });
    const outside = join(root, "outside.txt");
    await writeFile(outside, "DO_NOT_READ_PRIVATE_HOST_FILE");
    await symlink(outside, join(staged, "manifest.json"));
    const eventOutput = join(root, "output");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["scripts/validate-task-publication.ts"], {
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        SOURCE_REPOSITORY: "fongap-labs/synthetic-private-e2e",
        TASK_SOURCE_PRIVATE: "true",
        AW_REPOSITORY_POLICY: JSON.stringify({
          "fongap-labs/synthetic-private-e2e": ["release-source"],
        }),
        GITHUB_OUTPUT: eventOutput,
      },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_READ_PRIVATE_HOST_FILE/);
    assert.match(result.stderr, /manifest is unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
