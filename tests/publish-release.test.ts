import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTag, sha256File } from "../scripts/publish-release.ts";

test("release tags remain scoped by release key", () => {
  assert.equal(buildTag("example-tool", "1.2.3"), "example-tool-v1.2.3");
});

test("release assets use SHA256 digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "action-worker-test-"));
  try {
    const path = join(directory, "asset.txt");
    await writeFile(path, "action-worker\n", "utf8");
    assert.equal(
      await sha256File(path),
      "85cac77fc7fc9304c5de9f4e80b1c0f69f590e4f7f66f376ec8435b01d9fa6d2",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
