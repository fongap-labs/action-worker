import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertBridgeBootstrap } from "../scripts/verify-bridge-bootstrap.ts";

const bridge = ".github/workflows/notify-action-worker.yml";
const changelog = "CHANGELOG.md";
const template = "approved trusted notification template\n";
const hash = createHash("sha256").update(template).digest("hex");
const policy = [{ path: bridge, sha256: hash }];

test("trusted first-time bridge onboarding permits only approved bridge and change record", () => {
  assert.doesNotThrow(() =>
    assertBridgeBootstrap([bridge, changelog], [bridge, changelog], template, template, policy)
  );
  assert.doesNotThrow(() =>
    assertBridgeBootstrap([changelog, bridge], [bridge], template, template, policy)
  );
});

test("bootstrap rejects source files, build scripts and renamed changes", () => {
  for (const files of [
    [bridge],
    [bridge, changelog, "src/index.ts"],
    [bridge, "README.md"],
    [bridge, changelog, ".github/scripts/central-ci.sh"],
    [bridge, changelog, "tests/foo.ts"],
  ]) {
    assert.throws(() =>
      assertBridgeBootstrap(files, [bridge, changelog], template, template, policy)
    );
  }
  assert.throws(() =>
    assertBridgeBootstrap([bridge, changelog], [changelog], template, template, policy)
  );
});

test("bootstrap rejects changes to the approved template or approval policy", () => {
  assert.throws(() =>
    assertBridgeBootstrap([bridge, changelog], [bridge], template, template + " ", policy)
  );
  assert.throws(() =>
    assertBridgeBootstrap([bridge, changelog], [bridge], template, template, [])
  );
  assert.throws(() =>
    assertBridgeBootstrap([bridge, changelog], [bridge], template, template, [
      { path: bridge, sha256: "0".repeat(64) },
    ])
  );
  assert.throws(() =>
    assertBridgeBootstrap(
      [bridge, changelog],
      [bridge],
      template,
      template,
      [...policy, ...policy]
    )
  );
});
