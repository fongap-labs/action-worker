import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256File } from "../scripts/lib/stream-file-hash.ts";

test("streaming SHA-256 matches the standard digest for binary release assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-stream-hash-"));
  const file = join(directory, "asset.bin");
  const bytes = Buffer.concat([Buffer.from("release payload"), Buffer.from([0, 255, 17, 10])]);
  try {
    await writeFile(file, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(await sha256File(file), expected);
    await assert.rejects(sha256File(join(directory, "missing.bin")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
