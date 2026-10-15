import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { GithubHttpError } from "../scripts/github-api.ts";
import { discoverProducts, isProductName, selectProduct } from "../scripts/product-discovery.ts";
import {
  parseReleaseBuildRequest,
  resolveReleaseBuildProduct,
} from "../scripts/validate-release-build-request.ts";

const repository = "example-org/example-app";
const sha = "b".repeat(40);

// Models the contents API: a path that is a key is a file, and a path with keys below it is a directory.
// A missing path answers 404, as GitHub does, and every request must name the fixed commit.
function contentsReader(files: Record<string, string>) {
  return {
    async get(path: string): Promise<unknown> {
      const [route, query] = path.split("?");
      assert.equal(query, `ref=${sha}`, `every request names the commit: ${path}`);
      const prefix = `repos/${repository}/contents/`;
      assert.ok(route?.startsWith(prefix), `unexpected path: ${path}`);
      const target = decodeURIComponent((route ?? "").slice(prefix.length));
      if (Object.hasOwn(files, target)) {
        const text = files[target] ?? "";
        return {
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
          size: Buffer.byteLength(text),
        };
      }
      const children = new Map<string, { name: string; type: string; size: number }>();
      for (const [key, text] of Object.entries(files)) {
        if (!key.startsWith(`${target}/`)) continue;
        const [name = "", ...rest] = key.slice(target.length + 1).split("/");
        children.set(
          name,
          rest.length > 0
            ? { name, type: "dir", size: 0 }
            : { name, type: "file", size: Buffer.byteLength(text) }
        );
      }
      if (children.size === 0) {
        throw new GithubHttpError(404);
      }
      return [...children.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
  };
}

function releaseManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    artifact_name: "example-release",
    target_repository: "example-org/example-vault",
    release_key: "example",
    release_name: "Example",
    release_notes: "Example release.",
    license_expression: "Apache-2.0",
    node_version_file: "",
    python_version_file: "",
    sbom_asset: "",
    builds: [
      {
        id: "windows",
        runner_profile: "windows-build",
        target: "x86_64-pc-windows-msvc",
        script: ".github/scripts/release-build.ps1",
        assets: ["example.zip"],
        attest_asset: "example.zip",
      },
    ],
    ...overrides,
  });
}

const webManifest = releaseManifest({
  root: "projects/web/app",
  release_key: "web-app",
  artifact_name: "web-release",
  builds: [
    {
      id: "windows",
      runner_profile: "windows-build",
      target: "x86_64-pc-windows-msvc",
      script: ".github/scripts/release-build.ps1",
      assets: ["web.zip"],
      attest_asset: "web.zip",
    },
  ],
});
const apiManifest = releaseManifest({
  root: "projects/api",
  release_key: "api",
  artifact_name: "api-release",
  builds: [
    {
      id: "windows",
      runner_profile: "windows-build",
      target: "x86_64-pc-windows-msvc",
      script: ".github/scripts/release-build.ps1",
      assets: ["api.zip"],
      attest_asset: "api.zip",
    },
  ],
});

const multiProductTree = {
  "projects/web/release.manifest.json": webManifest,
  "projects/web/deploy.json": "{}",
  "projects/api/release.manifest.json": apiManifest,
  "projects/docs/README.md": "not a product",
};

test("a repository without projects/ keeps its root manifest as one product", async () => {
  const discovery = await discoverProducts(
    contentsReader({ ".github/release.manifest.json": releaseManifest() }),
    repository,
    sha
  );

  assert.equal(discovery.layout, "root");
  assert.equal(discovery.products.length, 1);
  assert.equal(discovery.products[0]?.name, "");
  assert.equal(discovery.products[0]?.directory, ".github");
  assert.equal(discovery.products[0]?.root, "");
  assert.equal(discovery.products[0]?.release_key, "example");
  assert.equal(selectProduct(discovery.products, "").name, "");
  assert.throws(() => selectProduct(discovery.products, "web"), /Leave product empty/);
});

test("a root manifest may declare a root without changing the root layout", async () => {
  const discovery = await discoverProducts(
    contentsReader({ ".github/release.manifest.json": releaseManifest({ root: "app" }) }),
    repository,
    sha
  );
  assert.equal(discovery.products[0]?.root, "app");
});

test("a repository with no manifest has no products, and the release fails with a clear message", async () => {
  const discovery = await discoverProducts(
    contentsReader({ "README.md": "no manifest here" }),
    repository,
    sha
  );
  assert.deepEqual(discovery, { layout: "root", products: [] });
  assert.throws(() => selectProduct(discovery.products, ""), /No product manifest was found/);
});

test("every product under projects/ is discovered and directories without manifests are ignored", async () => {
  const discovery = await discoverProducts(contentsReader(multiProductTree), repository, sha);

  assert.equal(discovery.layout, "projects");
  assert.deepEqual(
    discovery.products.map((product) => [product.name, product.directory, product.root]),
    [
      ["api", "projects/api", "projects/api"],
      ["web", "projects/web", "projects/web/app"],
    ]
  );
  assert.deepEqual(Object.keys(discovery.products[1]?.files ?? {}).sort(), [
    "deploy.json",
    "release.manifest.json",
  ]);
});

test("selecting a product requires a name when there are several, and checks the name", async () => {
  const { products } = await discoverProducts(contentsReader(multiProductTree), repository, sha);

  assert.throws(
    () => selectProduct(products, ""),
    /Product is required because the source repository has several products\. Choose one of: api, web\./
  );
  assert.throws(
    () => selectProduct(products, "admin"),
    /Unknown product: admin\. Choose one of: api, web\./
  );
  assert.throws(() => selectProduct(products, "../web"), /Product name is invalid/);
  assert.equal(selectProduct(products, "web").directory, "projects/web");
  assert.equal(selectProduct(products, "api").directory, "projects/api");
});

test("a single product under projects/ is selected without a name", async () => {
  const { products } = await discoverProducts(
    contentsReader({ "projects/web/release.manifest.json": webManifest }),
    repository,
    sha
  );
  assert.equal(selectProduct(products, "").name, "web");
  assert.equal(selectProduct(products, "web").name, "web");
  assert.throws(() => selectProduct(products, "api"), /Unknown product: api/);
});

test("an illegal product directory name is rejected", async () => {
  for (const name of ["-web", "web app", "a".repeat(65)]) {
    assert.equal(isProductName(name), false, name);
    await assert.rejects(
      discoverProducts(
        contentsReader({ [`projects/${name}/release.manifest.json`]: webManifest }),
        repository,
        sha
      ),
      /Product directory name is invalid/,
      name
    );
  }
});

test("a product release manifest must declare a relative root inside the repository", async () => {
  const missing = releaseManifest({ release_key: "web-app" });
  const absolute = releaseManifest({ root: "/projects/web", release_key: "web-app" });
  const escaping = releaseManifest({ root: "projects/../secrets", release_key: "web-app" });
  const empty = releaseManifest({ root: "", release_key: "web-app" });

  for (const manifest of [missing, absolute, escaping, empty]) {
    await assert.rejects(
      discoverProducts(
        contentsReader({ "projects/web/release.manifest.json": manifest }),
        repository,
        sha
      ),
      /Product release manifest must declare root/
    );
  }
});

test("root manifests and products under projects/ cannot coexist", async () => {
  await assert.rejects(
    discoverProducts(
      contentsReader({
        ".github/release.manifest.json": releaseManifest(),
        ...multiProductTree,
      }),
      repository,
      sha
    ),
    /Keep only one layout/
  );
});

test("a release key declared by two products is rejected and both products are named", async () => {
  await assert.rejects(
    discoverProducts(
      contentsReader({
        "projects/web/release.manifest.json": releaseManifest({
          root: "projects/web",
          release_key: "shared",
        }),
        "projects/api/release.manifest.json": releaseManifest({
          root: "projects/api",
          release_key: "shared",
        }),
      }),
      repository,
      sha
    ),
    /shared \(projects\/api, projects\/web\)/
  );
});

test("a product file larger than 64 KiB is rejected before it is read", async () => {
  const oversized = releaseManifest({
    root: "projects/web",
    release_key: "web-app",
    release_notes: "x".repeat(64 * 1024),
  });
  await assert.rejects(
    discoverProducts(
      contentsReader({ "projects/web/release.manifest.json": oversized }),
      repository,
      sha
    ),
    /larger than 64 KiB: projects\/web\/release\.manifest\.json/
  );
});

test("the release build reads the manifest the selected product names", async () => {
  const reader = contentsReader(multiProductTree);
  const request = parseReleaseBuildRequest({
    schema_version: "1",
    request_id: "release-build-1",
    source_repository: repository,
    source_sha: sha,
    requested_version: "1.2.3",
    product: "web",
  });

  const resolved = await resolveReleaseBuildProduct(reader, request);
  assert.equal(resolved.product, "web");
  assert.equal(resolved.manifest_path, "projects/web/release.manifest.json");
  assert.equal(resolved.product_root, "projects/web/app");
  assert.equal(resolved.manifest.release_key, "web-app");
  assert.deepEqual(resolved.manifest.builds[0]?.assets, ["web.zip"]);
});

test("the release build without a product fails when the repository has several", async () => {
  const request = parseReleaseBuildRequest({
    schema_version: "1",
    request_id: "release-build-1",
    source_repository: repository,
    source_sha: sha,
    requested_version: "1.2.3",
  });
  await assert.rejects(
    resolveReleaseBuildProduct(contentsReader(multiProductTree), request),
    /Choose one of: api, web/
  );
});

test("the release build of a single root manifest keeps the existing path and empty product root", async () => {
  const request = parseReleaseBuildRequest({
    schema_version: "1",
    request_id: "release-build-1",
    source_repository: repository,
    source_sha: sha,
    requested_version: "1.2.3",
  });
  const resolved = await resolveReleaseBuildProduct(
    contentsReader({ ".github/release.manifest.json": releaseManifest() }),
    request
  );
  assert.equal(resolved.product, "");
  assert.equal(resolved.manifest_path, ".github/release.manifest.json");
  assert.equal(resolved.product_root, "");
});

test("the release workflow names the product in its group and builds from the product root", async () => {
  const workflow = await readFile(".github/workflows/release-app.yml", "utf8");

  assert.match(
    workflow,
    /\n {6}product:\n {8}description: [^\n]+\n {8}required: false\n {8}type: string/
  );
  assert.ok(
    workflow.includes(
      "group: release-build-${{ github.event.client_payload.source_repository || inputs.source_repository }}${{ (github.event.client_payload.product || inputs.product) && format('-{0}', github.event.client_payload.product || inputs.product) || '' }}-${{ github.event.client_payload.source_sha || github.run_id }}"
    ),
    "concurrency group includes the product"
  );
  assert.match(workflow, /RELEASE_PRODUCT_ROOT/);
  assert.match(workflow, /"\$GITHUB_WORKSPACE\/source\/\$RELEASE_MANIFEST_PATH"/);
  assert.doesNotMatch(workflow, /source\/\.github\/release\.manifest\.json/);
});

// GitHub renders the group expression above. This helper mirrors that rendering so the uniqueness
// rule is checked here; the workflow test above pins the expression text itself.
function renderReleaseBuildGroup(source: string, product: string, sourceSha: string): string {
  return `release-build-${source}${product === "" ? "" : `-${product}`}-${sourceSha}`;
}

test("concurrency groups differ between products and keep the single-product format", () => {
  const web = renderReleaseBuildGroup(repository, "web", sha);
  const api = renderReleaseBuildGroup(repository, "api", sha);
  assert.notEqual(web, api);
  assert.equal(renderReleaseBuildGroup(repository, "", sha), `release-build-${repository}-${sha}`);
});
