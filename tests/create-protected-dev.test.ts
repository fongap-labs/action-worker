import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  bootstrapIntegrationId,
  createCompensatedDevBranch,
  createProtectedDevBranch,
} from "../scripts/create-protected-dev.ts";
import { GithubHttpError } from "../scripts/github-api.ts";
import { CliError } from "../scripts/runtime-command.ts";

const repository = "fongap-labs/example";
const sha = "a".repeat(40);
const policy = JSON.parse(readFileSync("policies/rulesets.json", "utf8")) as {
  rulesets: Array<Record<string, unknown>>;
};
const original = policy.rulesets.find((rule) => rule.name === "Protect Dev Branch")!;

function fixture(failWrite = false, reorderRules = false, target = repository) {
  const prefix = `repos/${target}`;
  const rulesPath = `${prefix}/rulesets`;
  const rules = new Map<number, Record<string, unknown>>([[12, structuredClone(original)]]);
  const events: string[] = [];
  let dev = "";
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === `${prefix}/branches/main`) return { commit: { sha } };
      if (path === `${prefix}/branches/dev`) {
        if (!dev) throw new CliError("HTTP 404");
        return { commit: { sha: dev } };
      }
      if (path === `${rulesPath}?includes_parents=false&per_page=100`) {
        return [...rules].map(([id, value]) => ({ ...value, id }));
      }
      const id = Number(path.split("/").at(-1)?.split("?")[0]);
      if (rules.has(id)) {
        const value = rules.get(id)!;
        if (reorderRules && events.includes("create") && Array.isArray(value.rules)) {
          return { ...value, id, rules: value.rules.toReversed() };
        }
        return { ...value, id };
      }
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
      assert.equal(path, `${rulesPath}/12`);
      assert.ok(rules.has(13));
      rules.set(12, body as Record<string, unknown>);
      events.push("update");
      return {};
    }
    assert.equal(path, `${rulesPath}/13`);
    assert.deepEqual(rules.get(12), original);
    rules.delete(13);
    events.push("cleanup");
    return undefined;
  };
  const createRef = async (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => {
    assert.equal(method, "POST");
    assert.equal(path, `${prefix}/git/refs`);
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

test("GitHub may reorder the restored rule array without changing branch protection", async () => {
  const f = fixture(false, true);
  await createProtectedDevBranch(f.reader, f.admin, f.createRef, repository, sha, 42);
  assert.equal(f.getDev(), sha);
  assert.deepEqual(f.events, ["guard", "update", "create", "update", "cleanup"]);
  assert.deepEqual([...f.rules], [[12, original]]);
});

test("controller dev uses the same protected creation procedure and restored lock", async () => {
  const target = "fongap-labs/action-worker";
  const f = fixture(false, false, target);
  await createProtectedDevBranch(f.reader, f.admin, f.createRef, target, sha, 42);
  assert.equal(f.getDev(), sha);
  assert.deepEqual(f.events, ["guard", "update", "create", "update", "cleanup"]);
  assert.deepEqual([...f.rules], [[12, original]]);
});

test("compensated private dev creation writes only the exact approved ref", async () => {
  const prefix = `repos/${repository}`;
  let dev = "";
  let isPrivate = true;
  let isLimited = true;
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === prefix) {
        return { full_name: repository, private: isPrivate, default_branch: "main" };
      }
      if (path.includes("/rulesets?")) {
        throw new GithubHttpError(403, undefined, {
          kind: isLimited ? "plan-restriction" : "permission",
        });
      }
      if (path === `${prefix}/branches/main`) return { commit: { sha } };
      if (path === `${prefix}/branches/dev`) {
        if (!dev) throw new GithubHttpError(404);
        return { commit: { sha: dev } };
      }
      return assert.fail(path);
    },
  };
  let writes = 0;
  const create = async (method: string, path: string, body?: unknown) => {
    assert.equal(method, "POST");
    assert.equal(path, `${prefix}/git/refs`);
    assert.deepEqual(body, { ref: "refs/heads/dev", sha });
    writes++;
    dev = sha;
    return {};
  };
  await createCompensatedDevBranch(reader, create, repository, sha);
  assert.equal(writes, 1);
  await assert.rejects(
    createCompensatedDevBranch(reader, create, repository, sha),
    /identity changed/
  );
  dev = "";
  isPrivate = false;
  await assert.rejects(
    createCompensatedDevBranch(reader, create, repository, sha),
    /capability changed/
  );
  isPrivate = true;
  isLimited = false;
  await assert.rejects(createCompensatedDevBranch(reader, create, repository, sha), /HTTP 403/);
  assert.equal(writes, 1);
});
