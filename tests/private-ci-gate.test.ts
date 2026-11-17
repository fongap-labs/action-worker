import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativePrivateCiArgs } from "../scripts/private-ci-gate.ts";

const valid = [
  "fongap-labs/delta-legacy",
  "491",
  "a".repeat(40),
  "b".repeat(40),
  "c".repeat(40),
  '["checks","deny"]',
  "true",
];

test("native private CI CLI requires a complete immutable identity", () => {
  assert.deepEqual(parseNativePrivateCiArgs(valid), {
    repository: "fongap-labs/delta-legacy",
    prNumber: 491,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeSha: "c".repeat(40),
    linuxShards: ["checks", "deny"],
    hasWindows: true,
  });
});

test("native private CI CLI rejects incomplete, mutable, or malformed identities", () => {
  const broken: string[][] = [
    valid.slice(0, -1),
    [...valid, "unused"],
    ["bad/repo/name", ...valid.slice(1)],
    [valid[0]!, "0", ...valid.slice(2)],
    [valid[0]!, "1e3", ...valid.slice(2)],
    [valid[0]!, valid[1]!, "main", ...valid.slice(3)],
    [...valid.slice(0, 5), "not-json", "true"],
    [...valid.slice(0, 5), "[]", "true"],
    [...valid.slice(0, 5), '["checks","checks"]', "true"],
    [...valid.slice(0, 6), "default"],
  ];
  for (const args of broken) assert.throws(() => parseNativePrivateCiArgs(args));
});
