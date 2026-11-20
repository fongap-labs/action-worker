#!/usr/bin/env node
// Verify the real TAP output from a trusted central pack against its case baseline.
// The baseline is owned by Action Worker; the tested repository cannot edit it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseTap, verify } from "./inventory.mjs";

/**
 * @param {{ schema_version?: number, runtime?: string, suites?: Record<string, { status: string, failed: string[], cases: Record<string, number> }> }} baseline
 * @param {string} output
 * @returns {string[]}
 */
export function verifyTapInventory(baseline, output) {
  if (
    baseline?.schema_version !== 1 ||
    baseline.runtime !== "node" ||
    !baseline.suites ||
    typeof baseline.suites !== "object" ||
    Array.isArray(baseline.suites) ||
    Object.keys(baseline.suites).length === 0
  ) {
    return ["invalid trusted Node test inventory baseline"];
  }
  if (!/^TAP version 13\s*$/m.test(output)) return ["missing Node TAP reporter output"];
  const footer = [...output.matchAll(/^# tests (\d+)\s*$/gm)].at(-1);
  const failed = [...output.matchAll(/^# fail (\d+)\s*$/gm)].at(-1);
  if (!footer || !failed || Number(failed[1]) !== 0) {
    return ["missing or failing TAP result footer"];
  }
  const parsed = parseTap(output, "__central_pack_inventory__.mjs");
  const cases = Object.values(baseline.suites).reduce(
    (sum, suite) => sum + Object.values(suite.cases).reduce((n, v) => n + v, 0),
    0
  );
  const actual = {
    schema_version: 1,
    runtime: "node",
    suites: {
      combined: {
        status: "pass",
        failed: parsed.failed,
        cases: parsed.cases,
      },
    },
  };
  const issues = verify(baseline, actual);
  if (Number(footer[1]) < cases) issues.push("fewer executed tests than trusted baseline");
  if (parsed.failed.length > 0) issues.push("one or more TAP assertions failed");
  return issues;
}

function main() {
  const [baselineFile, outputFile] = process.argv.slice(2);
  if (!baselineFile || !outputFile || process.argv.length !== 4) {
    console.error("usage: verify-tap-inventory.mjs <trusted-baseline.json> <test-tap.log>");
    process.exit(64);
  }
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const output = readFileSync(outputFile, "utf8");
  const problems = verifyTapInventory(baseline, output);
  if (problems.length > 0) {
    console.error(
      process.env.TARGET_PRIVATE === "true"
        ? "Trusted test case inventory mismatch; private details withheld."
        : `Trusted test case inventory mismatch: ${problems.join("; ")}`
    );
    process.exit(1);
  }
  console.log("Trusted runtime test case inventory verified.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
