import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectLegacyStateArchive } from "../scripts/verify-legacy-task-archive.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-legacy-state-"));
  const input = join(root, "input");
  await mkdir(input);
  return { root, input };
}

function tarBytes(root: string, format = "gnu"): Buffer {
  const archive = join(root, "state.tar.gz");
  execFileSync("tar", ["--format=" + format, "-czf", archive, "-C", join(root, "input"), "."]);
  return requireBytes(archive);
}

function requireBytes(path: string): Buffer {
  // Test fixture uses an explicitly controlled local archive.
  return execFileSync("cat", [path]);
}

function modifyFirstFileName(compressed: Buffer, name: string): Buffer {
  const archive = gunzipSync(compressed);
  const blocks = Math.floor(archive.length / 512);
  for (let i = 0; i < blocks; i++) {
    const start = i * 512;
    const header = archive.subarray(start, start + 512);
    const type = header[156] ?? 0;
    if ((type === 48 || type === 0) && header[0] !== 0) {
      header.fill(0, 0, 100);
      header.write(name, 0, "utf8");
      header.fill(32, 148, 156);
      let sum = 0;
      for (let offset = 0; offset < 512; offset++) sum += header[offset] ?? 0;
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      return gzipSync(archive);
    }
  }
  throw new Error("No file header found");
}

test("historical GNU tar state with regular files and directories is accepted", async () => {
  const { root, input } = await fixture();
  try {
    await mkdir(join(input, "nested"));
    await writeFile(join(input, "manifest.json"), '{"repository":"o/r","project":"p"}');
    await writeFile(join(input, "nested", "cursor.txt"), "42");
    const archive = tarBytes(root);
    const result = inspectLegacyStateArchive(archive);
    assert.equal(result.files, 2);
    assert.ok(result.directories >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical state refuses symlinks and hard links", async () => {
  const { root, input } = await fixture();
  try {
    await writeFile(join(input, "real.txt"), "content");
    await symlink("real.txt", join(input, "sym.txt"));
    assert.throws(() => inspectLegacyStateArchive(tarBytes(root)), /safe extraction/);
    await rm(join(input, "sym.txt"));
    await link(join(input, "real.txt"), join(input, "hard.txt"));
    assert.throws(() => inspectLegacyStateArchive(tarBytes(root)), /safe extraction/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical archive refuses traversal and corrupt checksums", async () => {
  const { root, input } = await fixture();
  try {
    await writeFile(join(input, "ok.txt"), "content");
    const archive = tarBytes(root);
    assert.throws(
      () => inspectLegacyStateArchive(modifyFirstFileName(archive, "../../escape")),
      /safe extraction/
    );
    const changed = gunzipSync(archive);
    changed[0] = 88;
    assert.throws(() => inspectLegacyStateArchive(gzipSync(changed)), /safe extraction/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical archive refuses oversized extracted files", async () => {
  const { root, input } = await fixture();
  try {
    await writeFile(join(input, "giant.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.throws(() => inspectLegacyStateArchive(tarBytes(root)), /safe extraction/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical gzip decoder refuses empty or invalid data", () => {
  assert.throws(() => inspectLegacyStateArchive(Buffer.alloc(0)), /safe extraction/);
  assert.throws(() => inspectLegacyStateArchive(Buffer.from("not-gzip")), /safe extraction/);
});
