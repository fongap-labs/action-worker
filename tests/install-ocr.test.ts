import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyAsset } from "../scripts/install-ocr.ts";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

async function fixture(binaryContent: string, checksumHex: string) {
  const dir = await mkdtemp(join(tmpdir(), "action-worker-ocr-"));
  const binary = join(dir, "ocr");
  const checksum = join(dir, "ocr.sha256");
  await writeFile(binary, binaryContent);
  await writeFile(checksum, `${checksumHex}  ocr\n`);
  return { dir, binary, checksum };
}

test("the OCR binary must match the digest pinned in policy", async (context) => {
  const good = await fixture("trusted build", sha("trusted build"));
  context.after(() => rm(good.dir, { recursive: true, force: true }));
  assert.equal(await verifyAsset(good.binary, good.checksum, sha("trusted build")), true);

  // A replaced release asset with a matching replaced checksum file is still refused.
  const swapped = await fixture("replaced build", sha("replaced build"));
  context.after(() => rm(swapped.dir, { recursive: true, force: true }));
  assert.equal(await verifyAsset(swapped.binary, swapped.checksum, sha("trusted build")), false);
});

test("the release checksum must agree with the pinned digest", async (context) => {
  const mismatch = await fixture("trusted build", sha("something else"));
  context.after(() => rm(mismatch.dir, { recursive: true, force: true }));
  assert.equal(await verifyAsset(mismatch.binary, mismatch.checksum, sha("trusted build")), false);
});

test("a malformed pinned digest never verifies", async (context) => {
  const good = await fixture("trusted build", sha("trusted build"));
  context.after(() => rm(good.dir, { recursive: true, force: true }));
  assert.equal(await verifyAsset(good.binary, good.checksum, ""), false);
  assert.equal(await verifyAsset(good.binary, good.checksum, "not-a-digest"), false);
});

test("review policy pins the OCR engine by SHA-256", async () => {
  const policy = JSON.parse(await readFile("policies/review.json", "utf8"));
  assert.match(policy.engine.sha256, /^[0-9a-f]{64}$/);
});
