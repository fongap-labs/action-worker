import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPushRefUpdates, parsePushRefUpdates } from "../scripts/privacy-push-preflight.ts";
import { runText } from "../scripts/runtime-command.ts";

const zero = "0".repeat(40);
const policy = resolve("policies/security.json");

async function git(root: string, args: string[]): Promise<string> {
  return (await runText("git", args, { cwd: root })).trim();
}

async function fixture(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), "privacy-push-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Synthetic Tester"]);
  await git(root, ["config", "user.email", ["synthetic", "example.invalid"].join("@")]);
  await writeFile(join(root, "README.md"), "Fixture\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  return { root, base: await git(root, ["rev-parse", "HEAD"]) };
}

async function commitFile(root: string, file: string, text: string): Promise<string> {
  await writeFile(join(root, file), text);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture"]);
  return await git(root, ["rev-parse", "HEAD"]);
}

test("pre-push parser accepts Git ref updates but rejects invalid or oversized input", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const updates = parsePushRefUpdates(
    "refs/heads/topic " + head + " refs/heads/topic " + base + "\n"
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.localSha, head);
  assert.throws(() => parsePushRefUpdates("refs/heads/topic bad refs/heads/topic " + base));
  assert.throws(() =>
    parsePushRefUpdates(
      "refs/heads/topic " + head + " refs/heads/topic " + base + "\n".repeat(66000)
    )
  );
});

test("pre-push scans every added commit even when the final tree removed a secret", async (context) => {
  const { root, base } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const token = "ghp_" + "A".repeat(26);
  await commitFile(root, "config.txt", "TOKEN=" + token + "\n");
  await unlink(join(root, "config.txt"));
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "remove secret"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const summary = await checkPushRefUpdates(root, policy, "origin", [
    {
      localRef: "refs/heads/topic",
      localSha: head,
      remoteRef: "refs/heads/topic",
      remoteSha: base,
    },
  ]);
  assert.equal(summary.checked_commits, 2);
  assert.ok(summary.violations.some((item) => item.rule === "github-token"));
  assert.doesNotMatch(JSON.stringify(summary), /config\.txt|ghp_/);
});

test("pre-push checks historical workflows from the commit instead of the final worktree", async (context) => {
  const { root, base } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  const path = join(root, ".github", "workflows", "ci.yml");
  await writeFile(
    path,
    "name: fixture\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@main\n"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "add unsafe workflow"]);
  await unlink(path);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "remove unsafe workflow"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const summary = await checkPushRefUpdates(root, policy, "origin", [
    {
      localRef: "refs/heads/topic",
      localSha: head,
      remoteRef: "refs/heads/topic",
      remoteSha: base,
    },
  ]);
  assert.ok(summary.violations.some((item) => item.rule === "unpinned-action"));
});

test("pre-push skips deletions and rejects unavailable history without claiming success", async (context) => {
  const { root, base } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const deletion = await checkPushRefUpdates(root, policy, "origin", [
    {
      localRef: "refs/heads/topic",
      localSha: zero,
      remoteRef: "refs/heads/topic",
      remoteSha: base,
    },
  ]);
  assert.deepEqual(deletion, { checked_commits: 0, violations: [] });
  await assert.rejects(() =>
    checkPushRefUpdates(root, policy, "origin", [
      {
        localRef: "refs/heads/topic",
        localSha: base,
        remoteRef: "refs/heads/topic",
        remoteSha: "f".repeat(40),
      },
    ])
  );
});

test("pre-push hook invokes the central script and never contains an allow-failure switch", async () => {
  const hook = await import("node:fs/promises").then((fs) =>
    fs.readFile(".githooks/pre-push", "utf8")
  );
  assert.match(hook, /node scripts\/privacy-push-preflight\.ts/);
  assert.doesNotMatch(hook, /exit 0|--no-verify|continue-on-error|warn/);
});
