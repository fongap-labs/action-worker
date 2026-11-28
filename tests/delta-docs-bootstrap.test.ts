import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deltaCleanRootTreeSha } from "../scripts/delta-clean-root.ts";
import {
  parseDocsTree,
  verifyDeltaDocsBootstrap,
  verifyDeltaDocsTree,
  verifyDeltaDocsTrustAnchor,
  verifyPrivateDocsTrees,
} from "../scripts/delta-docs-bootstrap.ts";

const paths = ["AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "LICENSE", "README.md"];
const entries = paths.map((path) => ({
  mode: "100644",
  type: "blob",
  sha: "a".repeat(40),
  path,
}));
const additions = ["A\tAGENTS.md", "A\tCHANGELOG.md", "A\tCLAUDE.md", "M\tREADME.md"];

test("Delta docs control checkout is pinned to the PR base or main head", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  assert.doesNotThrow(() =>
    verifyDeltaDocsTrustAnchor(base, base, head, "83", deltaCleanRootTreeSha)
  );
  assert.doesNotThrow(() =>
    verifyDeltaDocsTrustAnchor(head, base, head, "0", deltaCleanRootTreeSha)
  );
  assert.throws(
    () => verifyDeltaDocsTrustAnchor(base, base, head, "0", deltaCleanRootTreeSha),
    /control checkout/
  );
  assert.throws(
    () => verifyDeltaDocsTrustAnchor(head, base, head, "83", deltaCleanRootTreeSha),
    /control checkout/
  );
  assert.throws(
    () => verifyDeltaDocsTrustAnchor(base, base, head, "", deltaCleanRootTreeSha),
    /PR identity/
  );
  assert.throws(
    () => verifyDeltaDocsTrustAnchor(base, base, head, "-1", deltaCleanRootTreeSha),
    /PR identity/
  );
  assert.throws(
    () => verifyDeltaDocsTrustAnchor(head, base, head, "0", "c".repeat(40)),
    /trusted root/
  );
});

test("Delta docs-only root bootstrap validates exact regular files and safe document changes", () => {
  assert.doesNotThrow(() => verifyDeltaDocsTree(entries, additions));
  assert.deepEqual(
    parseDocsTree(
      entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`).join("")
    ),
    entries
  );
});

test("docs bootstrap cannot silently accept executable code, extra files or symlinks", () => {
  for (const forbidden of [
    { mode: "100644", type: "blob", sha: "b".repeat(40), path: "src/index.ts" },
    { mode: "100755", type: "blob", sha: "b".repeat(40), path: "AGENTS.md" },
    { mode: "120000", type: "blob", sha: "b".repeat(40), path: "CLAUDE.md" },
    { mode: "100644", type: "tree", sha: "b".repeat(40), path: "CHANGELOG.md" },
  ]) {
    const modified = entries.filter((entry) => entry.path !== forbidden.path);
    modified.push(forbidden);
    assert.throws(() => verifyDeltaDocsTree(modified, additions));
  }
  assert.throws(() => verifyDeltaDocsTree(entries.slice(1), additions), /missing/);
  assert.throws(() => verifyDeltaDocsTree([...entries, entries[0]!], additions), /regular/);
  assert.throws(() => parseDocsTree("100644 blob aaaa\tREADME.md"), /incomplete/);
});

test("docs bootstrap rejects code, license modifications, deletion and empty diffs", () => {
  for (const changes of [
    ["A\tsrc/index.ts"],
    ["M\tLICENSE"],
    ["D\tAGENTS.md"],
    ["R100\tREADME.md"],
    ["A\t.github/execution-manifest.json"],
    [],
  ]) {
    assert.throws(() => verifyDeltaDocsTree(entries, changes), /allowlist/);
  }
});

test("docs bootstrap never executes for another repository or a private target", () => {
  assert.throws(
    () => verifyDeltaDocsBootstrap("/unavailable", "/unavailable", "a".repeat(40), "b".repeat(40)),
    /restricted/
  );
});

test("the verified fallback is only reachable when the trusted execution manifest is absent", () => {
  const executor = readFileSync("scripts/execute-linux-ci.ts", "utf8");
  assert.match(executor, /!existsSync\(manifestPath\)/);
  assert.match(executor, /verifyDeltaDocsBootstrap\(targetRoot, controlRoot, base, head, shard\)/);
});

test("docs-only Delta bootstrap permits an unchanged pinned approved bridge but no modified bridge", () => {
  const trusted = "b".repeat(40);
  const bridge = {
    mode: "100644",
    type: "blob",
    sha: trusted,
    path: ".github/workflows/notify-action-worker.yml",
  };
  assert.doesNotThrow(() => verifyDeltaDocsTree([...entries, bridge], additions, trusted));
  assert.throws(() => verifyDeltaDocsTree([...entries, bridge], additions, "c".repeat(40)));
  assert.throws(() =>
    verifyDeltaDocsTree(
      [...entries, bridge],
      ["M\t.github/workflows/notify-action-worker.yml"],
      trusted
    )
  );
  assert.throws(() =>
    verifyDeltaDocsTree([...entries, { ...bridge, mode: "100755" }], additions, trusted)
  );
});

test("private docs bootstrap verifies both trees and never accepts source or bridge changes", () => {
  const trusted = "b".repeat(40);
  const bridge = {
    mode: "100644",
    type: "blob",
    sha: trusted,
    path: ".github/workflows/notify-action-worker.yml",
  };
  const base = [
    ...entries.filter((entry) => ["README.md", "CHANGELOG.md"].includes(entry.path)),
    bridge,
  ];
  const head = [...entries, bridge];
  const changes = ["A\tAGENTS.md", "A\tCLAUDE.md", "A\tLICENSE", "M\tREADME.md", "M\tCHANGELOG.md"];
  assert.doesNotThrow(() => verifyPrivateDocsTrees(base, head, changes, trusted, false));
  assert.doesNotThrow(() => verifyPrivateDocsTrees(head, head, [], trusted, true));
  for (const path of ["src/index.ts", ".github/execution-manifest.json"]) {
    const source = { ...entries[0]!, path };
    assert.throws(() => verifyPrivateDocsTrees([...base, source], head, changes, trusted, false));
    assert.throws(() => verifyPrivateDocsTrees(base, [...head, source], changes, trusted, false));
  }
  assert.throws(() => verifyPrivateDocsTrees(base, head, [], trusted, false));
  assert.throws(() => verifyPrivateDocsTrees(base, head, ["M\tLICENSE"], trusted, false));
  assert.throws(() =>
    verifyPrivateDocsTrees(
      base,
      head,
      ["M\t.github/workflows/notify-action-worker.yml"],
      trusted,
      false
    )
  );
  assert.throws(() => verifyPrivateDocsTrees(base, head, changes, "c".repeat(40), false));
});
