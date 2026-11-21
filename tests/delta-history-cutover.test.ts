import assert from "node:assert/strict";
import { test } from "node:test";
import { performDeltaHistoryCutover } from "../scripts/delta-history-cutover.ts";

const oldSha = "dee27ea15004fc905c9f4ad0e1c01cfca67c571f";
const newSha = "decc6ee1388df99d2769024ac78b0f153ab8800d";

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
