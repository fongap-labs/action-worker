import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = "scripts/artifact-privacy-scan.py";
const policy = "policies/security.json";

function run(
  directory: string,
  strictOpaque = false,
  extra: string[] = [],
  policyFile: string = policy
) {
  const args = [script, directory, policyFile];
  if (strictOpaque) args.push("--strict-opaque");
  const result = spawnSync("python3", [...args, ...extra], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

test("artifact context exceptions are exact and do not hide another match in the same window", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const address = ["verified", "example.invalid"].join("@");
  const approved = `${"A".repeat(64)}${address}${"B".repeat(64)}`;
  const digest = createHash("sha256").update(approved).digest("hex");
  const configured = JSON.parse(await readFile(policy, "utf8"));
  configured.artifact_context_allowlist = [
    {
      rule: "privacy-email-address",
      source: "verified public fixture",
      distribution_sha256: "a".repeat(64),
      reason: "Exact test context only.",
      context_sha256: [digest],
    },
  ];
  const policyFile = join(directory, "security.json");
  await writeFile(policyFile, JSON.stringify(configured), "utf8");
  const asset = join(directory, "runtime.exe");
  await writeFile(asset, `${approved}\n${address}`, "utf8");
  const result = run(directory, false, [], policyFile);
  assert.equal(result.status, 1);
  assert.match(result.output, /privacy-email-address/);
  assert.match(result.output, /"privacy_findings": 1/);
  assert.doesNotMatch(result.output, /verified public fixture|example\.invalid/);

  await writeFile(asset, `${approved.replace("B".repeat(64), "C".repeat(64))}`, "utf8");
  const changedContext = run(directory, false, [], policyFile);
  assert.equal(changedContext.status, 1);
  assert.match(changedContext.output, /privacy-email-address/);
});

test("artifact context exceptions fail closed when policy metadata is malformed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configured = JSON.parse(await readFile(policy, "utf8"));
  configured.artifact_context_allowlist = [
    {
      rule: "privacy-email-address",
      source: "verified source",
      distribution_sha256: "not-a-digest",
      reason: "Invalid fixture.",
      context_sha256: ["not-a-digest"],
    },
  ];
  const policyFile = join(directory, "security.json");
  await writeFile(policyFile, JSON.stringify(configured), "utf8");
  await writeFile(join(directory, "asset.txt"), "ordinary data", "utf8");
  const result = run(directory, false, [], policyFile);
  assert.equal(result.status, 1);
  assert.match(result.output, /invalid-policy/);
});

test("privacy fingerprints preserve exact secret-context exceptions without hashing secret contexts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secret = `AKIA${"A".repeat(16)}`;
  const approved = `${"A".repeat(64)}${secret}${"B".repeat(64)}`;
  const configured = JSON.parse(await readFile(policy, "utf8"));
  configured.artifact_context_allowlist = [{
    rule: "aws-access-key",
    source: "verified public fixture",
    distribution_sha256: "b".repeat(64),
    reason: "Exact test context only.",
    context_sha256: [createHash("sha256").update(approved).digest("hex")],
  }];
  const policyFile = join(directory, "security.json");
  await writeFile(policyFile, JSON.stringify(configured), "utf8");
  const asset = join(directory, "runtime.exe");
  await writeFile(asset, approved, "utf8");
  const accepted = run(directory, false, ["--diagnostics"], policyFile);
  assert.equal(accepted.status, 0);
  assert.doesNotMatch(accepted.output, /context_sha256|verified public fixture/);

  await writeFile(asset, approved.replace(/B{64}/, `${"C".repeat(64)}`), "utf8");
  const changed = run(directory, false, ["--diagnostics"], policyFile);
  assert.equal(changed.status, 1);
  assert.match(changed.output, /aws-access-key/);
  assert.doesNotMatch(changed.output, /context_sha256|verified public fixture/);
});

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

function hardlinkArchive(target: string, kind: string) {
  const code = [
    "import io,os,tarfile,zipfile",
    "kind=os.environ['KIND']; target=os.environ['TARGET']",
    "data=b'ordinary timezone fixture'",
    "if kind=='private': data=('developer'+chr(64)+'example.invalid').encode()",
    "if kind=='nested-private':",
    "  nested=io.BytesIO()",
    "  with zipfile.ZipFile(nested,'w',compression=zipfile.ZIP_DEFLATED) as z: z.writestr('data.txt',('developer'+chr(64)+'example.invalid').encode())",
    "  data=nested.getvalue()",
    "buf=io.BytesIO()",
    "with tarfile.open(fileobj=buf,mode='w:gz') as tar:",
    "  regular=tarfile.TarInfo('zone/data'); regular.size=len(data)",
    "  if kind!='forward': tar.addfile(regular,io.BytesIO(data))",
    "  alias=tarfile.TarInfo('zone/alias.zip' if kind=='nested-private' else 'zone/alias')",
    "  alias.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.LNKTYPE",
    "  alias.linkname={'missing':'zone/missing','traversal':'../data','absolute':'/data'}.get(kind,'zone/data')",
    "  if kind=='nonempty':",
    "    alias.size=1; tar.addfile(alias,io.BytesIO(b'x'))",
    "  else: tar.addfile(alias)",
    "  if kind=='forward': tar.addfile(regular,io.BytesIO(data))",
    "  if kind=='chain':",
    "    other=tarfile.TarInfo('zone/another'); other.type=tarfile.LNKTYPE; other.linkname='zone/alias'; tar.addfile(other)",
    "with zipfile.ZipFile(target,'w') as z: z.writestr('runtime/timezones.tar.gz',buf.getvalue())",
  ].join("\n");
  const result = spawnSync("python3", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, TARGET: target, KIND: kind },
  });
  assert.equal(result.status, 0, "synthetic nested archive generation failed");
}

test("release privacy scan accepts internal tar hardlinks and scans their aliased bytes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "bundle.zip");
  hardlinkArchive(target, "safe");
  const safe = run(directory);
  assert.equal(safe.status, 0, safe.output);
  assert.match(safe.output, /"files_scanned": 2/);
  hardlinkArchive(target, "private");
  const finding = run(directory);
  assert.equal(finding.status, 1);
  assert.ok(finding.output.includes("privacy-email-address]: 2"));
  assert.doesNotMatch(finding.output, /developer|zone\/alias/);
  hardlinkArchive(target, "nested-private");
  const nested = run(directory);
  assert.equal(nested.status, 1);
  assert.match(nested.output, /privacy-email-address/);
});

test("release privacy scan rejects unresolved, forward, chained, traversing and symbolic links", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "bundle.zip");
  for (const kind of [
    "missing",
    "forward",
    "chain",
    "traversal",
    "absolute",
    "symlink",
    "nonempty",
  ]) {
    hardlinkArchive(target, kind);
    const result = run(directory);
    assert.equal(result.status, 1, kind);
    assert.match(result.output, /unsafe-archive-(?:hardlink|path|entry)/);
    assert.doesNotMatch(result.output, /zone\/alias|runtime\/timezones/);
  }
});

test("release privacy scan preserves invalid byte boundaries without hiding real findings", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "time.bin");
  const address = ["developer", "example.invalid"].join("@");
  await writeFile(
    file,
    Buffer.concat([
      Buffer.from(address.slice(0, -7)),
      Buffer.from([255]),
      Buffer.from(address.slice(-7)),
    ])
  );
  assert.equal(run(directory).status, 0);
  await writeFile(
    file,
    Buffer.concat([
      Buffer.from([255]),
      Buffer.alloc(65523, 32),
      Buffer.from(address),
      Buffer.from([255]),
    ])
  );
  const finding = run(directory);
  assert.equal(finding.status, 1);
  assert.match(finding.output, /privacy-email-address/);
  assert.doesNotMatch(finding.output, /developer|time\.bin/);
});

test("release privacy diagnostics classify origins without revealing archive member names", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const address = ["developer", "example.invalid"].join("@");
  const target = join(directory, "bundle.zip");
  archive(target, "runtime/python/Lib/site-packages/hidden.dist-info/METADATA", address, "zip");
  const metadata = run(directory);
  assert.equal(metadata.status, 1);
  assert.ok(metadata.output.includes("python-packages/package-metadata/privacy-email-address"));
  assert.doesNotMatch(metadata.output, /developer|hidden|example\.invalid/);
  archive(target, "App/resources/app.asar", address, "zip");
  const asar = run(directory);
  assert.equal(asar.status, 1);
  assert.ok(asar.output.includes("electron-asar/asar/privacy-email-address"));
  assert.doesNotMatch(asar.output, /developer|resources\/app\.asar/);
  archive(target, "runtime/node_modules/hidden/index.js.map", address, "zip");
  const map = run(directory);
  assert.equal(map.status, 1);
  assert.ok(map.output.includes("node-dependencies/source-map/privacy-email-address"));
  assert.doesNotMatch(map.output, /developer|hidden|index\.js\.map/);
});

test("privacy diagnostics identify archive member and window without disclosing names or values", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const address = ["developer", "example.invalid"].join("@");
  archive(join(directory, "bundle.zip"), "private-name/module.pyc", address, "zip");
  const result = run(directory, false, ["--diagnostics"]);
  assert.equal(result.status, 1);
  const rows = result.output
    .split("\n")
    .filter((line) => line.startsWith("Release privacy locator "))
    .map((line) => JSON.parse(line.slice("Release privacy locator ".length)));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    area: "other",
    context_sha256: [createHash("sha256").update(address).digest("hex")],
    first_window: 1,
    kind: "binary",
    last_window: 1,
    locator: "1.1",
    rule: "privacy-email-address",
    source: "content",
    windows: 1,
  });
  assert.doesNotMatch(result.output, /developer|private-name|module\.pyc|example\.invalid/);
  assert.equal(run(directory).status, result.status);
});

test("privacy diagnostics enumerate opaque objects without changing the verdict", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "private-name.exe"), "ordinary binary fixture");
  const result = run(directory, false, ["--diagnostics"]);
  assert.equal(result.status, 0);
  assert.match(result.output, /"rule": "opaque-unverified"/);
  assert.match(result.output, /"locator": "1"/);
  assert.doesNotMatch(result.output, /private-name/);
  assert.equal(run(directory, true, ["--diagnostics"]).status, 1);
});

test("private path mapping is offline-only, exclusive and never placed inside release assets", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const report = join(directory, "report.json");
  const result = spawnSync("python3", [script, directory, policy, "--local-report", report], {
    encoding: "utf8",
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-report-inside-release/);
  const ci = spawnSync("python3", [script, directory, policy, "--local-report", report], {
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /local-report-forbidden-in-ci/);
});

test("offline private report maps the same locator to an exact archive chain without matching values", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "release-privacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "assets");
  await mkdir(directory);
  const address = ["developer", "example.invalid"].join("@");
  archive(join(directory, "bundle.zip"), "private-name/module.pyc", address, "zip");
  const report = join(root, "report.json");
  const args = [script, directory, policy, "--diagnostics", "--local-report", report];
  const env = { ...process.env, CI: "", GITHUB_ACTIONS: "" };
  const result = spawnSync("python3", args, { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /developer|private-name|module\.pyc/);
  const raw = await readFile(report, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed.details[0].relative_archive_chain, [
    "bundle.zip",
    "private-name/module.pyc",
  ]);
  assert.equal(parsed.details[0].locator, "1.1");
  assert.doesNotMatch(raw, /developer|example\.invalid/);
  const repeated = spawnSync("python3", args, { encoding: "utf8", env });
  assert.match(repeated.stderr, /local-report-write-failed/);
  assert.equal(await readFile(report, "utf8"), raw);
});
