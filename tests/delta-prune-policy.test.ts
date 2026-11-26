import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeltaPrunePolicy } from "../scripts/delta-prune-policy.ts";

const now = Date.parse("2026-11-26T00:00:00.000Z");
const base = {
  version: "v1",
  allowedProducts: ["desktop", "docker"],
  allowedCapabilities: ["agent", "plugins"],
  allowedEntrypoints: ["apps/desktop", "apps/web"],
  allowedArtifacts: ["desktop", "container"],
  deniedCapabilities: ["telemetry"],
  deniedPackages: [],
  deniedDependencies: [],
  exceptions: [],
  thresholds: { startupRegression: 0.1 },
};
const parse = (value: unknown) => parseDeltaPrunePolicy(JSON.stringify(value), now);

test("pruning policy has deterministic digest for equivalent allowlists", () => {
  const first = parse(base);
  const second = parse({ ...base, allowedProducts: ["docker", "desktop"] });
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.digest, parse({ ...base, version: "v2" }).digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test("pruning policy rejects missing, malformed, unknown and contradictory inputs", () => {
  assert.throws(() => parseDeltaPrunePolicy(undefined, now), /invalid/);
  assert.throws(() => parseDeltaPrunePolicy("{", now), /invalid/);
  for (const value of [
    { ...base, extra: true },
    { ...base, allowedProducts: [] },
    { ...base, allowedProducts: ["desktop", "desktop"] },
    { ...base, allowedEntrypoints: ["../outside"] },
    { ...base, allowedCapabilities: ["telemetry"] },
    { ...base, thresholds: { startupRegression: -1 } },
  ]) {
    assert.throws(() => parse(value), /invalid/);
  }
});

test("pruning policy refuses expired and unreviewable exception records", () => {
  const entry = {
    scope: "legacy-module",
    reason: "temporary compatibility investigation",
    approval: "approved-change-reference",
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
  assert.equal(parse({ ...base, exceptions: [entry] }).policy.exceptions.length, 1);
  for (const exceptions of [
    [{ ...entry, expiresAt: "2026-11-25T00:00:00.000Z" }],
    [{ ...entry, approval: "" }],
    [entry, entry],
  ]) {
    assert.throws(() => parse({ ...base, exceptions }), /invalid/);
  }
});

test("optional source privacy rules are exact, deterministic and reject broad exceptions", () => {
  const rule = { term: "dsh_session_log", allowedPaths: ["scripts/guard.ts", "tests/guard.spec.ts"] };
  const first = parse({ ...base, deniedSourceRules: [rule] });
  assert.equal(
    first.digest,
    parse({ ...base, deniedSourceRules: [{ ...rule, allowedPaths: [...rule.allowedPaths].reverse() }] })
      .digest
  );
  assert.notEqual(first.digest, parse(base).digest);
  for (const deniedSourceRules of [
    [{ ...rule, allowedPaths: ["packages/*"] }],
    [{ ...rule, allowedPaths: ["../outside"] }],
    [{ ...rule, allowedPaths: ["/absolute"] }],
    [rule, rule],
    [{ ...rule, term: ".*" }],
    [{ ...rule, extra: true }],
  ]) {
    assert.throws(() => parse({ ...base, deniedSourceRules }), /invalid/);
  }
});
