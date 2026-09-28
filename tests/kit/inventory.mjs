#!/usr/bin/env node
// Runtime test inventory: no static analysis. Every suite is executed once
// under the Node TAP reporter and the observed case names are recorded.
//
//   collect  --dir <suites dir> --cwd <working dir> --out <file> [--preload <module>] [--suffix -test.mjs]
//   verify   --baseline <file> --current <file>
//
// The committed baseline is produced from the pre-migration suites. verify fails
// when any baseline case is missing (or has fewer occurrences) in the current
// inventory, so consolidating files can never silently drop a case.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const legacyCase = /^# (ok|not ok) - (.+)$/;
const subtestCase = /^\s*(ok|not ok) \d+ - (.+?)(?: # .*)?$/;

export function parseTap(output, file) {
  const cases = {};
  const failed = [];
  const own = basename(file);
  for (const line of output.split(/\r?\n/)) {
    const legacy = legacyCase.exec(line);
    const subtest = legacy ? null : subtestCase.exec(line);
    const match = legacy ?? subtest;
    if (!match) continue;
    const name = match[2].trim();
    if (subtest && (name.endsWith(own) || name === file)) continue;
    if (match[1] === "not ok") failed.push(name);
    else cases[name] = (cases[name] ?? 0) + 1;
  }
  return { cases, failed };
}

export function collectNode({ dir, cwd, suffix, preload, env }) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort();
  const suites = {};
  for (const name of files) {
    const args = ["--test", "--test-reporter=tap"];
    if (preload) args.push("--import", pathToFileURL(preload).href);
    args.push(join(dir, name));
    const run = spawnSync(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const parsed = parseTap(`${run.stdout}\n${run.stderr}`, name);
    const id = name.slice(0, -suffix.length);
    if (Object.keys(parsed.cases).length === 0) parsed.cases[`file:${id}`] = 1;
    suites[id] = {
      status: run.status === 0 ? "pass" : "fail",
      failed: parsed.failed,
      cases: parsed.cases,
    };
  }
  return suites;
}

export function collectPython({ dir, cwd, env, executed, config }) {
  const root = resolve(dir);
  const base = [
    "-m",
    "pytest",
    root,
    `--rootdir=${root}`,
    "-q",
    "--tb=no",
    "-p",
    "no:cacheprovider",
  ];
  if (config) base.push("-c", resolve(config));
  const options = {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  };
  const listed = (path) => path.replaceAll("\\", "/");
  const reported = (path) => relative(root, resolve(cwd, path)).replaceAll("\\", "/");
  const suites = {};
  const listing = spawnSync("python", [...base, "--collect-only"], options);
  for (const line of listing.stdout.split(/\r?\n/)) {
    const match = /^(\S+?\.py)::(.+)$/.exec(line.trim());
    if (!match) continue;
    const id = listed(match[1]);
    const suite = suites[id] ?? { status: "collected", failed: [], cases: {}, passed: [] };
    suites[id] = suite;
    suite.cases[match[2]] = (suite.cases[match[2]] ?? 0) + 1;
  }
  if (executed) {
    const run = spawnSync("python", [...base, "-rA"], options);
    for (const line of run.stdout.split(/\r?\n/)) {
      const match = /^PASSED (\S+?\.py)::(.+)$/.exec(line.trim());
      if (match) suites[reported(match[1])]?.passed.push(match[2]);
    }
  }
  return suites;
}

export function flatten(inventory) {
  const total = {};
  for (const suite of Object.values(inventory.suites)) {
    for (const [name, count] of Object.entries(suite.cases))
      total[name] = (total[name] ?? 0) + count;
  }
  return total;
}

export function verify(baseline, current) {
  const problems = [];
  for (const [id, suite] of Object.entries(current.suites)) {
    if (suite.status === "fail") problems.push(`suite failing: ${id}`);
  }
  // Passing state is compared by case name (a case may move between files when suites are merged).
  const countPassed = (inv) => {
    const total = {};
    for (const suite of Object.values(inv.suites))
      for (const name of suite.passed ?? []) total[name] = (total[name] ?? 0) + 1;
    return total;
  };
  const passedNow = countPassed(current);
  if (baseline.runtime === "python" && Object.keys(passedNow).length > 0) {
    for (const [name, count] of Object.entries(countPassed(baseline))) {
      if ((passedNow[name] ?? 0) < count)
        problems.push(`no longer passing (${passedNow[name] ?? 0}/${count}): ${name}`);
    }
  }
  const have = flatten(current);
  for (const [name, count] of Object.entries(flatten(baseline))) {
    if ((have[name] ?? 0) < count)
      problems.push(`missing case (${have[name] ?? 0}/${count}): ${name}`);
  }
  return problems;
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "collect-python") {
    const suites = collectPython({
      dir: option(args, "dir"),
      cwd: resolve(option(args, "cwd") ?? "."),
      env: option(args, "target")
        ? {
            CENTRAL_TEST_TARGET_ROOT: resolve(option(args, "target")),
            PYTHONPATH: [
              resolve(option(args, "target")),
              resolve(dirname(fileURLToPath(import.meta.url)), "python"),
              process.env.PYTHONPATH,
            ]
              .filter(Boolean)
              .join(delimiter),
          }
        : {},
      executed: args.includes("--run"),
      config: option(args, "config"),
    });
    const cases = Object.values(suites).reduce(
      (n, s) => n + Object.values(s.cases).reduce((a, b) => a + b, 0),
      0
    );
    const passed = Object.values(suites).reduce((n, s) => n + s.passed.length, 0);
    writeFileSync(
      option(args, "out"),
      `${JSON.stringify({ schema_version: 1, runtime: "python", suites }, null, 2)}
`
    );
    console.log(
      `inventory: ${Object.keys(suites).length} files, ${cases} collected, ${passed} passed`
    );
    return;
  }
  if (command === "collect") {
    const dir = resolve(option(args, "dir"));
    const suites = collectNode({
      dir,
      cwd: resolve(option(args, "cwd") ?? "."),
      suffix: option(args, "suffix") ?? "-test.mjs",
      preload: option(args, "preload"),
      env: option(args, "target")
        ? { CENTRAL_TEST_TARGET_ROOT: resolve(option(args, "target")) }
        : {},
    });
    const cases = Object.values(suites).reduce(
      (n, s) => n + Object.values(s.cases).reduce((a, b) => a + b, 0),
      0
    );
    writeFileSync(
      option(args, "out"),
      `${JSON.stringify({ schema_version: 1, runtime: "node", suites }, null, 2)}\n`
    );
    console.log(`inventory: ${Object.keys(suites).length} suites, ${cases} cases`);
    return;
  }
  if (command === "verify") {
    const read = (name) => JSON.parse(readFileSync(option(args, name), "utf8"));
    const problems = verify(read("baseline"), read("current"));
    for (const problem of problems) console.error(problem);
    console.log(
      problems.length === 0
        ? "inventory: OK (no case lost)"
        : `inventory: FAILED (${problems.length})`
    );
    process.exit(problems.length === 0 ? 0 : 1);
  }
  console.error("usage: inventory.mjs collect|verify ...");
  process.exit(64);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
