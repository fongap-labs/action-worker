import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTestPackConfig } from "../scripts/resolve-test-pack.ts";

const sha = "c".repeat(40);

test("accepts a pack pinned to main or to a full commit SHA", () => {
  assert.deepEqual(parseTestPackConfig('{"schema_version":1,"pack":"ai-gateway","ref":"main"}'), {
    pack: "ai-gateway",
    ref: "main",
  });
  assert.deepEqual(parseTestPackConfig(`{"schema_version":1,"pack":"delta","ref":"${sha}"}`), {
    pack: "delta",
    ref: sha,
  });
});

test("rejects unsafe pack names, mutable refs and unknown fields", () => {
  for (const text of [
    "not json",
    "[]",
    '{"schema_version":2,"pack":"delta","ref":"main"}',
    '{"schema_version":1,"pack":"../delta","ref":"main"}',
    '{"schema_version":1,"pack":"Delta","ref":"main"}',
    '{"schema_version":1,"pack":"delta","ref":"feature/x"}',
    '{"schema_version":1,"pack":"delta","ref":"abc123"}',
    '{"schema_version":1,"pack":"delta","ref":"main","command":"rm -rf /"}',
  ]) {
    assert.throws(() => parseTestPackConfig(text), text);
  }
});

test("a pinned pack is checked out only when it is trusted history", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { prepareTestPack } = await import("../scripts/prepare-test-pack.ts");

  const root = await mkdtemp(join(tmpdir(), "test-pack-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(root, "a.txt"), "one");
  git("add", ".");
  git("commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  await writeFile(join(root, "a.txt"), "two");
  git("commit", "-qam", "two");
  git("checkout", "-q", "-b", "side", first);
  await writeFile(join(root, "b.txt"), "side");
  git("add", ".");
  git("commit", "-qm", "side");
  const sideTip = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");

  const configPath = join(root, "test-pack.json");
  const write = (ref: string) =>
    writeFile(configPath, JSON.stringify({ schema_version: 1, pack: "example", ref }));

  await write("main");
  assert.equal(await prepareTestPack(root, configPath), "main");
  assert.equal(await prepareTestPack(root, join(root, "missing.json")), "main");

  await write(first);
  assert.equal(await prepareTestPack(root, configPath), first);
  git("checkout", "-q", "main");

  await write(sideTip);
  await assert.rejects(prepareTestPack(root, configPath), /not part of the trusted/);
});
