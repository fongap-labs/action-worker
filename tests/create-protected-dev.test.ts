import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bootstrapIntegrationId, createProtectedDevBranch } from "../scripts/create-protected-dev.ts";
import { CliError } from "../scripts/runtime-command.ts";

const repository = "fongap-labs/example";
const prefix = "repos/" + repository;
const sha = "a".repeat(40);
const rulesPath = prefix + "/rulesets";
const policy = JSON.parse(readFileSync("policies/rulesets.json", "utf8")) as {
  rulesets: Array<Record<string, unknown>>;
};
const original = policy.rulesets.find((rule) => rule.name === "Protect Dev Branch")!;

function fixture(failWrite = false) {
  const rules = new Map<number, Record<string, unknown>>([[12, structuredClone(original)]]);
  const events: string[] = [];
  let dev = "";
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === prefix + "/branches/main") return { commit: { sha } };
      if (path === prefix + "/branches/dev") {
        if (!dev) throw new CliError("HTTP 404");
        return { commit: { sha: dev } };
      }
      if (path === rulesPath + "?includes_parents=false&per_page=100") {
        return [...rules].map(([id, value]) => ({ ...value, id }));
      }
      const id = Number(path.split("/").at(-1)?.split("?")[0]);
      if (rules.has(id)) return { ...rules.get(id), id };
      assert.fail(path);
    },
  };
  const admin = async (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => {
    if (method === "POST") {
      assert.equal(path, rulesPath);
      assert.deepEqual(rules.get(12), original);
      rules.set(13, body as Record<string, unknown>);
      events.push("guard");
      return { id: 13 };
    }
    if (method === "PUT") {
      assert.equal(path, rulesPath + "/12");
      assert.ok(rules.has(13));
      rules.set(12, body as Record<string, unknown>);
      events.push("update");
      return {};
    }
    assert.equal(path, rulesPath + "/13");
    assert.deepEqual(rules.get(12), original);
    rules.delete(13);
    events.push("cleanup");
    return undefined;
  };
  const createRef = async (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => {
    assert.equal(method, "POST");
    assert.equal(path, prefix + "/git/refs");
    assert.deepEqual(body, { ref: "refs/heads/dev", sha });
    assert.deepEqual(rules.get(12)?.bypass_actors, []);
    assert.deepEqual(rules.get(12)?.rules, [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "update" },
    ]);
    assert.deepEqual(rules.get(13)?.rules, [{ type: "creation" }]);
    assert.deepEqual(rules.get(13)?.bypass_actors, [
      { actor_id: 42, actor_type: "Integration", bypass_mode: "always" },
    ]);
    events.push("create");
    if (failWrite) throw new CliError("HTTP 422");
    dev = sha;
    return {};
  };
  return { reader, admin, createRef, events, rules, getDev: () => dev };
}

test("only creation is temporarily delegated; closed protection is restored before success", async () => {
  const f = fixture();
  await createProtectedDevBranch(f.reader, f.admin, f.createRef, repository, sha, 42);
  assert.equal(f.getDev(), sha);
  assert.deepEqual(f.events, ["guard", "update", "create", "update", "cleanup"]);
  assert.deepEqual([...f.rules], [[12, original]]);
});

test("creation rejection restores closed protection and propagates the failure", async () => {
  const f = fixture(true);
  await assert.rejects(
    createProtectedDevBranch(f.reader, f.admin, f.createRef, repository, sha, 42),
    /HTTP 422/
  );
  assert.equal(f.getDev(), "");
  assert.deepEqual([...f.rules], [[12, original]]);
});

test("a previous temporary guard fails closed before mutation", async () => {
  const f = fixture();
  f.rules.set(13, { name: "Dev Bootstrap Creation Guard" });
  await assert.rejects(
    createProtectedDevBranch(f.reader, f.admin, f.createRef, repository, sha, 42),
    /unfinished/
  );
  assert.deepEqual(f.events, []);
});

test("bootstrap integration is derived from the existing reviewed policy", () => {
  assert.ok(bootstrapIntegrationId() > 0);
});
