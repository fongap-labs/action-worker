import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildReleaseTitle,
  buildTag,
  mirrorSourceIsCurrent,
  sha256File,
  validateArchive,
} from "../scripts/publish-release.ts";

test("a mirror source may lag the default branch only while its own pins are unchanged", () => {
  const compare = (status: string, filenames: string[]) => ({
    status,
    files: filenames.map((filename) => ({ filename })),
  });
  // Changelog commits of other releases, and other tools, do not invalidate a mirror.
  assert.equal(
    mirrorSourceIsCurrent(compare("ahead", ["CHANGELOG.md", "tools/rsm/tool.json"]), "doe-base"),
    true
  );
  assert.equal(mirrorSourceIsCurrent(compare("identical", []), "doe-base"), true);
  // Its own directory changed, or the source is not an ancestor, or the file list is unreadable.
  assert.equal(
    mirrorSourceIsCurrent(compare("ahead", ["tools/doe-base/tool.json"]), "doe-base"),
    false
  );
  assert.equal(mirrorSourceIsCurrent(compare("diverged", []), "doe-base"), false);
  assert.equal(mirrorSourceIsCurrent(compare("behind", []), "doe-base"), false);
  assert.equal(mirrorSourceIsCurrent({ status: "ahead" }, "doe-base"), false);
  const truncated = Array.from({ length: 300 }, (_, index) => `docs/${index}.md`);
  assert.equal(mirrorSourceIsCurrent(compare("ahead", truncated), "doe-base"), false);
});

test("release tags remain scoped by release key", () => {
  assert.equal(buildTag("example-tool", "1.2.3"), "example-tool-v1.2.3");
});

test("release titles are the product name followed by the version", () => {
  assert.equal(buildReleaseTitle("Delta", "0.1.0"), "Delta v0.1.0");
  assert.equal(buildReleaseTitle(undefined, "0.1.0"), "v0.1.0");
  assert.equal(buildReleaseTitle("", "0.1.0"), "v0.1.0");
});

test("release assets use SHA256 digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "action-worker-test-"));
  try {
    const path = join(directory, "asset.txt");
    await writeFile(path, "action-worker\n", "utf8");
    assert.equal(
      await sha256File(path),
      "85cac77fc7fc9304c5de9f4e80b1c0f69f590e4f7f66f376ec8435b01d9fa6d2"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release archives allow only unique root-level files", () => {
  assert.deepEqual(validateArchive("release-manifest.json\nasset.tar.gz\n"), [
    "release-manifest.json",
    "asset.tar.gz",
  ]);
  assert.throws(() => validateArchive("release-manifest.json\nnested/asset.tar.gz\n"));
  assert.throws(() => validateArchive("release-manifest.json\nrelease-manifest.json\n"));
  assert.throws(() => validateArchive(""));
});
