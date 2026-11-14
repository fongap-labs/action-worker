import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = "scripts/release-artifact-privacy-scan.py";
const policy = "policies/security.json";

function run(directory: string, strictOpaque = false) {
  const args = [script, directory, policy];
  if (strictOpaque) args.push("--strict-opaque");
  const result = spawnSync("python3", args, { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

function archive(target: string, name: string, content: string, kind: "zip" | "tar") {
  const code =
    "import io,os,tarfile,zipfile\n" +
    "path=os.environ['TARGET']; name=os.environ['ENTRY']; data=os.environ['BODY'].encode()\n" +
    "if os.environ['KIND']=='zip':\n" +
    "  with zipfile.ZipFile(path,'w') as z: z.writestr(name,data)\n" +
    "else:\n" +
    "  with tarfile.open(path,'w:gz') as t:\n" +
    "    info=tarfile.TarInfo(name); info.size=len(data); t.addfile(info,io.BytesIO(data))\n";
  const result = spawnSync("python3", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, TARGET: target, ENTRY: name, BODY: content, KIND: kind },
  });
  assert.equal(result.status, 0, "synthetic fixture archive generation failed");
}

test("release privacy scan accepts ordinary relative files without reporting identities", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "README.txt"), "Relative path: src/core/runtime.ts\n");
  const result = run(directory);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /"privacy_findings": 0/);
});

test("release privacy scan blocks user or developer addresses inside zip archives", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const address = ["developer", "example.invalid"].join("@");
  archive(join(directory, "bundle.zip"), "source/config.map", "contact=" + address, "zip");
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.output, /privacy-email-address/);
  assert.doesNotMatch(result.output, /developer|config\.map/);
});

test("release privacy scan blocks local home paths inside compressed tarballs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const local = ["", "Users", "developer", "Documents", "private.txt"].join("/");
  archive(join(directory, "release.tgz"), "assets/metadata.txt", "path=" + local, "tar");
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.output, /privacy-unix-home-path/);
  assert.doesNotMatch(result.output, /private.txt|developer/);
});

test("release privacy scan rejects path traversal and has a strict opaque mode", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  archive(join(directory, "bad.zip"), "../escape.txt", "safe", "zip");
  assert.match(run(directory).output, /unsafe-archive-path/);
  await rm(join(directory, "bad.zip"));
  await writeFile(join(directory, "program.exe"), "binary-fixture");
  assert.equal(run(directory).status, 0);
  const strict = run(directory, true);
  assert.equal(strict.status, 1);
  assert.match(strict.output, /opaque-asset-not-verifiable/);
});
