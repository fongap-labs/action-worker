import assert from "node:assert/strict";
import { test } from "node:test";
import { performDeltaHistoryCutover } from "../scripts/delta-history-cutover.ts";

const oldSha = "4870259d11d8468d6d494f9d609e70c148416cf8";
const newSha = "8b73554a94a115c3fc8310e882036ef887f0569c";

function fixture(
  options: { failPreflight?: boolean; failTarget?: boolean; moveDuringDisable?: boolean } = {}
) {
  let main = oldSha;
  let protectedMain = true;
  const calls: string[] = [];
  return {
    calls,
    get main() {
      return main;
    },
    get protectedMain() {
      return protectedMain;
    },
    operations: {
      preflight: async () => {
        calls.push("preflight");
        if (options.failPreflight) throw new Error("preflight failed");
      },
      getMainSha: async () => {
        calls.push("get");
        return main;
      },
      disableProtection: async () => {
        calls.push("disable");
        protectedMain = false;
        if (options.moveDuringDisable) main = "f".repeat(40);
      },
      restoreProtection: async () => {
        calls.push("restore");
        protectedMain = true;
      },
      writeMain: async (sha: string) => {
        calls.push(`write:${sha}`);
        main = sha;
      },
      verifyTarget: async () => {
        calls.push("verify");
        if (options.failTarget) throw new Error("target verification failed");
      },
    },
  };
}

test("trusted immutable cutover verifies source and destination, restoring protections", async () => {
  const f = fixture();
  await performDeltaHistoryCutover(f.operations);
  assert.equal(f.main, newSha);
  assert.equal(f.protectedMain, true);
  assert.deepEqual(f.calls, [
    "preflight",
    "get",
    "disable",
    "get",
    `write:${newSha}`,
    "get",
    "verify",
    "restore",
  ]);
});

test("preflight failures never disable protection or write main", async () => {
  const f = fixture({ failPreflight: true });
  await assert.rejects(performDeltaHistoryCutover(f.operations), /preflight failed/);
  assert.equal(f.main, oldSha);
  assert.equal(f.protectedMain, true);
  assert.deepEqual(f.calls, ["preflight"]);
});

test("concurrent main movement is rejected and the ruleset is restored", async () => {
  const f = fixture({ moveDuringDisable: true });
  await assert.rejects(performDeltaHistoryCutover(f.operations), /main moved while/);
  assert.equal(f.protectedMain, true);
  assert.ok(!f.calls.some((call) => call.startsWith("write:")));
  assert.equal(f.calls.at(-1), "restore");
});

test("failed target verification rolls main back before restoration", async () => {
  const f = fixture({ failTarget: true });
  await assert.rejects(performDeltaHistoryCutover(f.operations), /target verification failed/);
  assert.equal(f.main, oldSha);
  assert.equal(f.protectedMain, true);
  assert.deepEqual(f.calls.slice(-3), ["get", `write:${oldSha}`, "restore"]);
});

test("migration isolates Git ref reads, contents writes, and ruleset administration", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile("scripts/delta-history-cutover.ts", "utf8");
  const workflow = await readFile(".github/workflows/delta-history-cutover.yml", "utf8");
  assert.match(script, /getMainSha: async \(\) => await getMainSha\(readToken\)/);
  assert.match(script, /git\/refs\/heads\/main`?, writeToken/);
  assert.doesNotMatch(script, /getMainSha\(adminToken\)/);
  assert.doesNotMatch(script, /git\/refs\/heads\/main`?, adminToken/);
  assert.match(workflow, /repositories: delta\n\s+permission-contents: write/);
  assert.match(workflow, /AW_MIGRATION_WRITE_TOKEN: \$\{\{ steps\.delta_write\.outputs\.token \}\}/);
});
