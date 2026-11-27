import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBetaPushReceipt,
  betaPushContext,
  betaPushIdentity,
  resolveBetaPushCandidates,
} from "../scripts/beta-push-dispatch.ts";
import { GithubHttpError } from "../scripts/github-api.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const controlRepository = "fongap-labs/action-worker";
const sha = "a".repeat(40);
const product = "alpha";
const key = repository + "/" + product;
const binding = { credential_environment: "beta-alpha-ops", credentials: {}, allow_push: true };
const manifest = {
  schema_version: "2",
  adapter: "source-script",
  root: "projects/alpha",
  entrypoint: "projects/alpha/deploy.sh",
  runner_profile: "production-deploy",
  ignore_docs_only: true,
  environments: { beta: { triggers: { push: true } }, production: { triggers: { push: true } } },
};

function fixture(files: string[], target: unknown = binding, repoPrivate = false) {
  const routes: Record<string, unknown> = {
    [`repos/${repository}`]: {
      full_name: repository,
      private: repoPrivate,
      default_branch: "main",
    },
    [`repos/${repository}/commits/dev`]: { sha },
    [`repos/${repository}/commits/${sha}`]: {
      files: files.map((filename) => ({ filename })),
    },
    [`repos/${repository}/contents/projects`]: [{ name: product, type: "dir", size: 0 }],
    [`repos/${repository}/contents/projects/alpha`]: [
      { name: "deploy.json", type: "file", size: 400 },
    ],
    [`repos/${repository}/contents/projects/alpha/deploy.json`]: {
      encoding: "base64",
      content: Buffer.from(JSON.stringify(manifest), "utf8").toString("base64"),
    },
  };
  return {
    reader: {
      async get(path: string) {
        const file = path.split("?")[0]!;
        if (!Object.hasOwn(routes, file)) throw new GithubHttpError(404);
        return routes[file];
      },
    },
    repositoryPolicy: { [repository]: ["pr", "deploy"] },
    betaPolicy: { schema_version: 1, targets: { [key]: target } },
    controlRepository,
    onlyRepository: "",
  };
}

test("Beta push discovery is scoped to current dev, exact product grants and changed paths", async () => {
  assert.deepEqual(await resolveBetaPushCandidates(fixture(["projects/alpha/code.ts"])), [
    { repository, product, sha, credential_environment: "beta-alpha-ops" },
  ]);
  assert.deepEqual(await resolveBetaPushCandidates(fixture(["projects/alpha/README.md"])), []);
  assert.deepEqual(await resolveBetaPushCandidates(fixture(["projects/other/code.ts"])), []);
  assert.deepEqual(
    await resolveBetaPushCandidates(
      fixture(["projects/alpha/code.ts"], { ...binding, allow_push: false })
    ),
    []
  );
  assert.deepEqual(
    await resolveBetaPushCandidates(fixture(["projects/alpha/code.ts"], binding, true)),
    []
  );
  assert.deepEqual(
    await resolveBetaPushCandidates({
      ...fixture(["projects/alpha/code.ts"]),
      betaPolicy: { schema_version: 1, targets: { [repository]: binding } },
    }),
    []
  );
});

test("Beta push ingress requires the exact signed reservation and deterministic request", async () => {
  const id = betaPushIdentity(repository, product, sha);
  const status = {
    context: betaPushContext(product),
    state: "pending",
    description: "Beta push dispatch reserved",
  };
  const signed = attestFixtureStatuses([status], repository, sha);
  const reader = { get: async () => signed };
  await assertBetaPushReceipt(reader, repository, product, sha, id);
  await assert.rejects(assertBetaPushReceipt(reader, repository, product, sha, "other"));
  await assert.rejects(
    assertBetaPushReceipt({ get: async () => [status] }, repository, product, sha, id)
  );
  await assert.rejects(
    assertBetaPushReceipt(
      reader,
      repository,
      "other",
      sha,
      betaPushIdentity(repository, "other", sha)
    )
  );
});
