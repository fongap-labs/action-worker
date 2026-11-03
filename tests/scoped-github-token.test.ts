import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { requireToken, resolveToken, scopeEnvName } from "../scripts/control-token.ts";

test("scoped GitHub tokens never inherit control or GH_TOKEN credentials", () => {
  const env = { AW_CONTROL_TOKEN: "control", GH_TOKEN: "generic" };
  for (const scope of ["status", "issue", "dispatch", "checkout"] as const) {
    assert.equal(resolveToken(scope, env), "");
    assert.throws(
      () => requireToken(scope, env),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(scopeEnvName(scope)) &&
        error.message.includes("Settings") &&
        error.message.includes("No token fallback")
    );
  }
  assert.equal(requireToken("control", env), "control");
});

test("each scoped credential is selected only by its own name", () => {
  const env = {
    AW_STATUS_TOKEN: "status",
    AW_ISSUE_TOKEN: "issue",
    AW_DISPATCH_TOKEN: "dispatch",
    AW_CHECKOUT_TOKEN: "checkout",
    AW_CONTROL_TOKEN: "control",
    GH_TOKEN: "generic",
  };
  for (const scope of ["status", "issue", "dispatch", "checkout", "control"] as const) {
    assert.equal(requireToken(scope, env), scope);
  }
});

test("workflows never substitute control token for scoped status, issue, or dispatch secrets", async () => {
  const folder = ".github/workflows";
  const paths = (await readdir(folder)).filter((name) => name.endsWith(".yml"));
  for (const path of paths) {
    const source = await readFile(`${folder}/${path}`, "utf8");
    assert.doesNotMatch(
      source,
      /secrets\.AW_(?:STATUS|ISSUE|DISPATCH)_TOKEN\s*\|\|\s*secrets\.AW_CONTROL_TOKEN/,
      path
    );
  }
});

test("private dependency repair cannot silently checkout with github.token", async () => {
  const workflow = await readFile(".github/workflows/dependency-repair-dispatch.yml", "utf8");
  assert.match(workflow, /name: Require private checkout token/);
  assert.match(workflow, /if: needs\.prepare\.outputs\.is_private == 'true'/);
  assert.match(workflow, /token: \\$\{\{ secrets\.AW_CHECKOUT_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /AW_CHECKOUT_TOKEN\s*\|\|\s*github\.token/);
});
