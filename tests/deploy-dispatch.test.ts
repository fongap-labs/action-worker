import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoRequiredReviewers,
  automaticDeployTargets,
  deployDecision,
  deployEventType,
  isDocsOnly,
  parseDeployPolicy,
  shouldDeployCurrentMain,
} from "../scripts/dispatch-central-deploy.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

test("deploy executor registry is repository-agnostic and source-script only", () => {
  const policy = {
    schema_version: 2 as const,
    adapters: {
      "source-script": { event_type: "run-source-script-deploy" },
    },
  };
  const parsed = parseDeployPolicy(policy);
  assert.deepEqual(parsed, policy);
  assert.equal(deployEventType(parsed, "source-script"), "run-source-script-deploy");
  assert.equal("repositories" in parsed, false);
  assert.throws(() =>
    parseDeployPolicy({
      ...policy,
      repositories: {},
    })
  );
  assert.throws(() =>
    parseDeployPolicy({
      schema_version: 2,
      adapters: {
        "source-script": {
          event_type: "run-source-script-deploy",
          repository: "fongap-labs/example",
        },
      },
    })
  );
});

test("documentation-only deploy classification is deterministic", () => {
  assert.equal(isDocsOnly(["README.md", "docs/deploy.md"]), true);
  assert.equal(isDocsOnly(["docs/deploy.md", ".github/workflows/deploy.yml"]), false);
  assert.equal(isDocsOnly([]), false);
});

test("a commit overtaken by documentation-only commits deploys the current main instead", () => {
  const files = (...names: string[]) => names.map((filename) => ({ filename }));
  const docsAhead = { status: "ahead", files: files("README.md", "docs/deploy.md") };
  // The newer main would skip itself as documentation-only, so the older change ships with it.
  assert.equal(shouldDeployCurrentMain(docsAhead, true), true);
  // The newer main changes code and deploys after its own central CI.
  const codeAhead = { status: "ahead", files: files("README.md", "src/server.ts") };
  assert.equal(shouldDeployCurrentMain(codeAhead, true), false);
  // Without the documentation rule the newer main always deploys itself.
  assert.equal(shouldDeployCurrentMain(docsAhead, false), false);
  // Main was rewritten rather than extended: the newer main is on its own.
  assert.equal(shouldDeployCurrentMain({ ...docsAhead, status: "diverged" }, true), false);
  // GitHub truncates long comparisons, so a full page may hide code changes.
  const truncated = {
    status: "ahead",
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
  };
  assert.equal(shouldDeployCurrentMain(truncated, true), false);
});

// --- product triggers ----------------------------------------------------------------------------

const sha = "0123456789abcdef0123456789abcdef01234567";
const controlRepository = "fongap-labs/action-worker";

function comparison(status: string, ...names: string[]) {
  return { status, files: names.map((filename) => ({ filename })) };
}

test("a push deploys an environment only when a changed file lies on its trigger paths", () => {
  const paths = ["projects/alpha/**", "shared/lib/**"];
  assert.equal(deployDecision(paths, true, ["other/x.ts"]), "path-unchanged");
  assert.equal(deployDecision(paths, true, ["projects/alpha/src/a.ts"]), "deploy");
  assert.equal(deployDecision(paths, true, ["shared/lib/util.ts"]), "deploy");
  // A trigger names a directory: a sibling with a longer name is not inside it.
  assert.equal(deployDecision(paths, true, ["projects/alpha2/src/a.ts"]), "path-unchanged");
});

test("documentation only counts inside the trigger paths", () => {
  const paths = ["projects/alpha/**"];
  assert.equal(deployDecision(paths, true, ["projects/alpha/README.md"]), "documentation-only");
  // Documentation outside the paths neither deploys nor blocks a code change inside them.
  assert.equal(deployDecision(paths, true, ["README.md", "projects/alpha/src/a.ts"]), "deploy");
  assert.equal(
    deployDecision(paths, true, ["other/a.ts", "projects/alpha/README.md"]),
    "documentation-only"
  );
  assert.equal(deployDecision(paths, false, ["projects/alpha/README.md"]), "deploy");
});

test("a repository-wide trigger keeps the whole-repository rules", () => {
  assert.equal(deployDecision(["**"], true, []), "deploy");
  assert.equal(deployDecision(["**"], true, ["docs/a.md", "README.md"]), "documentation-only");
  assert.equal(deployDecision(["**"], true, ["docs/a.md", "src/a.ts"]), "deploy");
});

test("a moved main deploys the current main when the newer commits would not deploy this environment", () => {
  const paths = ["projects/alpha/**"];
  // The newer change is outside the paths, so the newer main does not deploy alpha.
  assert.equal(shouldDeployCurrentMain(comparison("ahead", "other/x.ts"), true, paths), true);
  // The newer change is code inside the paths, so it deploys itself.
  assert.equal(
    shouldDeployCurrentMain(comparison("ahead", "projects/alpha/src/a.ts"), true, paths),
    false
  );
  // The newer change is documentation inside the paths, which the source skips.
  assert.equal(
    shouldDeployCurrentMain(comparison("ahead", "projects/alpha/README.md"), true, paths),
    true
  );
  assert.equal(
    shouldDeployCurrentMain(comparison("ahead", "projects/alpha/README.md"), false, paths),
    false
  );
});

function environmentReader(response: unknown) {
  return {
    async get(path: string): Promise<unknown> {
      if (path !== `repos/${controlRepository}/environments/production`) {
        throw new Error(`unexpected path: ${path}`);
      }
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("an automatic environment with required reviewers is refused, and an unreadable one is not skipped", async () => {
  await assertNoRequiredReviewers(
    environmentReader({ protection_rules: [] }),
    controlRepository,
    "production"
  );
  await assertNoRequiredReviewers(
    environmentReader({ protection_rules: [{ type: "wait_timer", wait_timer: 0 }] }),
    controlRepository,
    "production"
  );
  await assert.rejects(
    assertNoRequiredReviewers(
      environmentReader({
        protection_rules: [{ type: "required_reviewers", reviewers: [] }],
      }),
      controlRepository,
      "production"
    ),
    /requires reviewers, so an automatic deploy cannot finish/
  );
  await assert.rejects(
    assertNoRequiredReviewers(
      environmentReader(new GithubHttpError(404)),
      controlRepository,
      "production"
    ),
    /cannot be read with AW_CONTROL_TOKEN \(HTTP 404\); automatic deploy is refused/
  );
  await assert.rejects(
    assertNoRequiredReviewers(environmentReader({}), controlRepository, "production"),
    /no protection rules/
  );
});

// A repository reader for the contents API: directories list their entries, files serve base64
// content, and anything else answers 404 as GitHub does.
function repositoryReader(options: {
  directories: Record<string, Array<{ name: string; type: string; size: number }>>;
  files: Record<string, unknown>;
  environments?: Record<string, unknown>;
}) {
  return {
    async get(path: string): Promise<unknown> {
      const [file = ""] = path.split("?");
      const environment = file.match(/\/environments\/([^/]+)$/)?.[1];
      if (environment !== undefined && options.environments) {
        if (Object.hasOwn(options.environments, environment)) {
          return options.environments[environment];
        }
        throw new GithubHttpError(404);
      }
      const location = file.split("/contents/")[1] ?? "";
      if (Object.hasOwn(options.directories, location)) {
        return options.directories[location];
      }
      if (Object.hasOwn(options.files, location)) {
        return {
          encoding: "base64",
          content: Buffer.from(JSON.stringify(options.files[location]), "utf8").toString("base64"),
        };
      }
      throw new GithubHttpError(404);
    },
  };
}

const alphaManifest = {
  schema_version: "2",
  adapter: "source-script",
  root: "projects/alpha",
  entrypoint: "projects/alpha/deploy.sh",
  runner_profile: "production-deploy",
  ignore_docs_only: true,
  environments: {
    production: { triggers: { push: true } },
    staging: { triggers: { push: { paths: ["projects/alpha/**", "shared/lib/**"] } } },
    manual: {},
  },
};

const productEnvironments = {
  production: { protection_rules: [] },
  staging: { protection_rules: [] },
  manual: { protection_rules: [] },
};

test("the automatic targets are the products and environments with a push trigger", async () => {
  const reader = repositoryReader({
    directories: {
      projects: [
        { name: "alpha", type: "dir", size: 0 },
        { name: "notes", type: "dir", size: 0 },
      ],
      "projects/alpha": [{ name: "deploy.json", type: "file", size: 400 }],
      "projects/notes": [{ name: "README.md", type: "file", size: 10 }],
    },
    files: { "projects/alpha/deploy.json": alphaManifest },
    environments: productEnvironments,
  });
  assert.deepEqual(
    await automaticDeployTargets(reader, "fongap-labs/example", sha, controlRepository),
    [
      { product: "alpha", environment: "production" },
      { product: "alpha", environment: "staging" },
    ]
  );
});

test("a root manifest that is automatic targets the root product", async () => {
  const reader = repositoryReader({
    directories: {
      ".github": [{ name: "deploy.json", type: "file", size: 300 }],
    },
    files: {
      ".github/deploy.json": {
        schema_version: "1",
        adapter: "source-script",
        automatic: true,
        ignore_docs_only: true,
        runner_profile: "production-deploy",
        environment: "production",
        entrypoint: "scripts/deploy.sh",
      },
    },
    environments: { production: { protection_rules: [] } },
  });
  assert.deepEqual(
    await automaticDeployTargets(reader, "fongap-labs/example", sha, controlRepository),
    [{ product: "", environment: "production" }]
  );
});

test("an automatic environment that requires reviewers stops the automatic targets", async () => {
  const reader = repositoryReader({
    directories: {
      projects: [{ name: "alpha", type: "dir", size: 0 }],
      "projects/alpha": [{ name: "deploy.json", type: "file", size: 400 }],
    },
    files: { "projects/alpha/deploy.json": alphaManifest },
    environments: {
      production: { protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
      staging: { protection_rules: [] },
    },
  });
  await assert.rejects(
    automaticDeployTargets(reader, "fongap-labs/example", sha, controlRepository),
    /Environment production requires reviewers/
  );
});

test("a manual-only environment is not checked for reviewers, because it never deploys automatically", async () => {
  const reader = repositoryReader({
    directories: {
      projects: [{ name: "alpha", type: "dir", size: 0 }],
      "projects/alpha": [{ name: "deploy.json", type: "file", size: 400 }],
    },
    files: {
      "projects/alpha/deploy.json": {
        ...alphaManifest,
        environments: { manual: {} },
      },
    },
    environments: {},
  });
  assert.deepEqual(
    await automaticDeployTargets(reader, "fongap-labs/example", sha, controlRepository),
    []
  );
});
