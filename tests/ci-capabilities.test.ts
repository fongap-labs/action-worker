import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCiCapabilities } from "../scripts/resolve-ci-capabilities.ts";

test("CI capability resolver validates repository and trusted ref before GitHub access", async () => {
  await assert.rejects(
    resolveCiCapabilities("bad repository", "main", "token"),
    /Invalid repository/,
  );
  await assert.rejects(
    resolveCiCapabilities("fongap/example", "../main", "token"),
    /Invalid trusted control ref/,
  );
  await assert.rejects(
    resolveCiCapabilities("fongap/example", "main", ""),
    /AW_CONTROL_TOKEN is required/,
  );
});
