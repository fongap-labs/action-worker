import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrivateRefArgs } from "../scripts/private-ref-gate.ts";

const valid = [
  "fongap-labs/delta-legacy",
  "a".repeat(40),
  "b".repeat(40),
  '["checks","desktop"]',
  "true",
];

test("private main evidence CLI requires immutable exact source identity", () => {
  assert.deepEqual(parsePrivateRefArgs(valid), {
    repository: "fongap-labs/delta-legacy",
    beforeSha: "a".repeat(40),
    headSha: "b".repeat(40),
    linuxShards: ["checks", "desktop"],
    hasWindows: true,
  });
});

test("private main CLI rejects missing or ambiguous evidence", () => {
  const invalid: string[][] = [
    valid.slice(1),
    [...valid, "extra"],
    ["bad/path/repo", ...valid.slice(1)],
    [valid[0]!, "main", ...valid.slice(2)],
    [valid[0]!, valid[1]!, valid[1]!, ...valid.slice(3)],
    [...valid.slice(0, 3), "not-json", "true"],
    [...valid.slice(0, 3), "[]", "true"],
    [...valid.slice(0, 3), '["checks","checks"]', "true"],
    [...valid.slice(0, 4), "default"],
  ];
  for (const args of invalid) assert.throws(() => parsePrivateRefArgs(args));
});
