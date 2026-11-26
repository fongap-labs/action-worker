import assert from "node:assert/strict";
import { test } from "node:test";
import { statusAwareReader } from "../scripts/github-api.ts";
import { withProtectionReads } from "../scripts/protection-read-scope.ts";

test("protection reads use the isolated identity; normal reads preserve App tokens", async () => {
  const original = globalThis.fetch;
  const tokens: string[] = [];
  let disclose = true;
  globalThis.fetch = async (_url, init) => {
    tokens.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json(disclose ? { bypass_actors: [] } : {});
  };
  try {
    const repo = "fongap-labs/example";
    const control = "fongap-labs/action-worker";
    const reader = withProtectionReads(
      statusAwareReader("https://api.github.test", "control", "status"),
      "protection",
      [repo],
      control
    );
    const detail = `repos/${repo}/rulesets/12?includes_parents=false`;
    await reader.get(detail);
    await reader.get(`repos/${control}/environments/branch-transfer`);
    await reader.get(`repos/${repo}/commits/main/status`);
    await reader.get(`repos/${repo}/branches/main`);
    assert.deepEqual(tokens, [
      "Bearer protection",
      "Bearer control",
      "Bearer status",
      "Bearer control",
    ]);
    await assert.rejects(
      reader.get("repos/outside/repo/rulesets/12?includes_parents=false"),
      /outside the approved/
    );
    await assert.rejects(reader.get(`repos/${repo}/rulesets/12`), /query is not authorized/);
    await assert.rejects(
      reader.get(`repos/${repo}/environments/branch-transfer`),
      /outside the approved/
    );
    disclose = false;
    await assert.rejects(reader.get(detail), /did not disclose bypass_actors/);
    const missing = withProtectionReads(
      statusAwareReader("https://api.github.test", "control", "status"),
      "",
      [repo]
    );
    await assert.rejects(missing.get(detail), /Missing admin-ops/);
  } finally {
    globalThis.fetch = original;
  }
});

test("approval metadata works even when the administration token cannot read Actions", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer protection") return Response.json({}, { status: 404 });
    assert.equal(token, "Bearer control");
    return Response.json({ name: "branch-transfer" });
  };
  try {
    const repo = "fongap-labs/example";
    const control = "fongap-labs/action-worker";
    const reader = withProtectionReads(
      statusAwareReader("https://api.github.test", "control", "status"),
      "protection",
      [repo],
      control
    );
    assert.deepEqual(await reader.get(`repos/${control}/environments/branch-transfer`), {
      name: "branch-transfer",
    });
    await assert.rejects(
      reader.get(`repos/${repo}/rulesets/12?includes_parents=false`),
      /Cannot read managed ruleset detail \(HTTP 404\)/
    );
  } finally {
    globalThis.fetch = original;
  }
});
