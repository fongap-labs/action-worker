import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReleaseNotes,
  bumpForChanges,
  changesFromSpan,
  classifyCommit,
  commitRecordsFromCompare,
  commitRecordsFromList,
  isMergeSubject,
  loadReleaseSpan,
  nextVersion,
} from "../scripts/compute-release-version.ts";

const sha = (seed: string): string =>
  seed
    .split("")
    .map((character) => (character.charCodeAt(0) % 16).toString(16))
    .join("")
    .padEnd(40, "0")
    .slice(0, 40);

test("commit subjects classify under the eleven change types", () => {
  assert.deepEqual(classifyCommit("feat: add repository allowlist validation"), {
    type: "feat",
    attributes: [],
    summary: "add repository allowlist validation",
  });
  assert.deepEqual(classifyCommit("fix(router): stop retrying a disabled provider"), {
    type: "fix",
    attributes: [],
    summary: "stop retrying a disabled provider",
  });
  assert.equal(classifyCommit("update files"), null);
  assert.deepEqual(classifyCommit("chore: update work metrics (#926)"), {
    type: "chore",
    attributes: [],
    summary: "update work metrics",
  });
});

test("the breaking marker and the breaking footer fold into one attribute", () => {
  assert.deepEqual(classifyCommit("feat(auth)!: replace the legacy authentication contract"), {
    type: "feat",
    attributes: ["breaking"],
    summary: "replace the legacy authentication contract",
  });
  assert.deepEqual(
    classifyCommit("fix: guard the sandbox\n\nBREAKING CHANGE: the configuration keys moved"),
    {
      type: "fix",
      attributes: ["breaking"],
      summary: "guard the sandbox",
    }
  );
  assert.deepEqual(classifyCommit("fix: raise the limit\n\nBREAKING-CHANGE: keys moved"), {
    type: "fix",
    attributes: ["breaking"],
    summary: "raise the limit",
  });
});

test("merge subjects skip the classification without failing", () => {
  assert.equal(isMergeSubject("Merge pull request #12 from fongap-labs/main"), true);
  assert.equal(isMergeSubject("Merge branch 'main' of github.com"), true);
  assert.equal(isMergeSubject("Merge remote-tracking branch 'origin/main'"), true);
  assert.equal(isMergeSubject("fix: merge the module boundaries cleanly"), false);
});

test("the bump follows CHANGELOG_CONVENTIONS §6", () => {
  assert.equal(bumpForChanges([]), null);
  assert.equal(bumpForChanges([{ type: "docs", attributes: [] }]), null);
  assert.equal(bumpForChanges([{ type: "chore", attributes: [] }]), null);
  assert.equal(bumpForChanges([{ type: "fix", attributes: [] }]), "patch");
  assert.equal(bumpForChanges([{ type: "perf", attributes: [] }]), "patch");
  assert.equal(bumpForChanges([{ type: "revert", attributes: [] }]), "patch");
  assert.equal(bumpForChanges([{ type: "feat", attributes: [] }]), "minor");
  assert.equal(
    bumpForChanges([
      { type: "fix", attributes: [] },
      { type: "feat", attributes: [] },
    ]),
    "minor"
  );
  assert.equal(bumpForChanges([{ type: "feat", attributes: ["breaking"] }]), "major");
  // CHANGELOG_CONVENTIONS §6: a change with an attribute is release-worthy even at a low-value type.
  assert.equal(bumpForChanges([{ type: "chore", attributes: ["security"] }]), "patch");
});

test("nextVersion applies SemVer, including the 0.x minor rule", () => {
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.0", "major"), "0.2.0");
  assert.equal(nextVersion(undefined, "minor"), "0.1.0");
  assert.equal(nextVersion(undefined, "patch"), "0.0.1");
  assert.throws(() => nextVersion("1.2", "patch"), /non-stable version base/);
});

test("release notes keep the entry format and drop the low-value types", () => {
  const notes = buildReleaseNotes([
    { type: "docs", attributes: [], summary: "explain the release flow" },
    { type: "fix", attributes: [], summary: "stop the retry storm" },
    { type: "chore", attributes: ["security"], summary: "rotate the scan key" },
    { type: "feat", attributes: ["breaking", "migration"], summary: "move the config format" },
  ]);
  assert.equal(
    notes,
    [
      "- fix: stop the retry storm",
      "- chore [security]: rotate the scan key",
      "- feat [breaking, migration]: move the config format",
    ].join("\n")
  );
});

test("release notes refuse to exceed the manifest limit", () => {
  const long: { type: string; attributes: string[]; summary: string }[] = Array.from(
    { length: 2000 },
    (_, index) => ({ type: "fix", attributes: [], summary: `fix number ${index} `.padEnd(20, "x") })
  );
  assert.throws(() => buildReleaseNotes(long), /manifest limit/);
});

test("compare responses refuse to truncate the span", () => {
  const commits = Array.from({ length: 2 }, (_, index) => ({
    sha: sha(`a${index}`),
    message: "fix: a",
  }));
  assert.equal(commitRecordsFromCompare({ total_commits: 2, commits }).length, 2);
  assert.throws(
    () => commitRecordsFromCompare({ total_commits: 5, commits }),
    /Enter an explicit requested_version/
  );
});

test("commit lists keep a hard record budget", () => {
  const page = Array.from({ length: 100 }, (_, index) => ({
    sha: sha(`b${index}`),
    message: "fix: a",
  }));
  assert.equal(commitRecordsFromList([page, page.slice(0, 50)]).length, 150);
  assert.throws(() => commitRecordsFromList([page, page, page, page]), /span reader accepts/);
});

test("a span with an unparsable subject fails closed and names the offender", () => {
  assert.throws(
    () =>
      changesFromSpan([
        { sha: sha("c"), message: "misc changes" },
        { sha: sha("d"), message: "fix: a proper one" },
      ]),
    /not Conventional Commits titles.*misc changes/
  );
  assert.deepEqual(changesFromSpan([{ sha: sha("e"), message: "Merge branch 'x'" }]), []);
});

function spanReader(responses: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path in responses) {
        return responses[path];
      }
      throw new Error(`unexpected span path: ${path}`);
    },
  };
}

test("a first release reads the whole branch and proposes the smallest version", async () => {
  const reader = spanReader({
    "repos/fongap-labs/delta/tags?per_page=100&page=1": [],
    "repos/fongap-labs/delta/commits?sha=main&per_page=100&page=1": [
      { sha: sha("1"), message: "feat: the first capability" },
      { sha: sha("2"), message: "docs: the readme" },
    ],
  });
  const span = await loadReleaseSpan(reader, {
    target_repository: "fongap-labs/delta",
    source_repository: "fongap-labs/delta",
    source_sha: sha("1"),
    default_branch: "main",
    release_key: "delta",
    root: "",
  });
  assert.equal(span.base_version, undefined);
  assert.deepEqual(bumpForChanges(span.changes), "minor");
  assert.equal(nextVersion(span.base_version, "minor"), "0.1.0");
});

test("a following release reads the span between the last release tag and the head", async () => {
  const baseTagSha = sha("tag");
  const reader = spanReader({
    "repos/fongap-labs/delta/tags?per_page=100&page=1": [
      { name: "delta-v1.2.3", commit: { sha: baseTagSha } },
      { name: "delta-v1.0.0", commit: { sha: sha("older") } },
    ],
    "repos/fongap-labs/delta/commits/delta-v1.2.3": {
      sha: baseTagSha,
    },
    [`repos/fongap-labs/delta/compare/${baseTagSha}...${sha("head")}`]: {
      total_commits: 2,
      commits: [
        { sha: sha("head"), message: "fix: a later fix" },
        { sha: sha("mid"), message: "feat: a feature" },
      ],
    },
  });
  const span = await loadReleaseSpan(reader, {
    target_repository: "fongap-labs/delta",
    source_repository: "fongap-labs/delta",
    source_sha: sha("head"),
    default_branch: "main",
    release_key: "delta",
    root: "",
  });
  assert.equal(span.base_version, "1.2.3");
  assert.deepEqual(bumpForChanges(span.changes), "minor");
  assert.equal(nextVersion(span.base_version, "minor"), "1.3.0");
});

test("a product root keeps the span to the commits of its own tree", async () => {
  const baseTagSha = sha("ptag");
  const head = sha("phead");
  const other = sha("pother");
  const reader = spanReader({
    "repos/fongap-labs/app-source/tags?per_page=100&page=1": [
      { name: "web-v0.4.0", commit: { sha: baseTagSha } },
    ],
    [`repos/fongap-labs/app-source/commits/${encodeURIComponent("web-v0.4.0")}`]: {
      sha: baseTagSha,
    },
    [`repos/fongap-labs/app-source/compare/${baseTagSha}...${head}`]: {
      total_commits: 2,
      commits: [
        { sha: head, message: "fix: the web form" },
        { sha: other, message: "feat: an unrelated product feature" },
      ],
    },
  });
  const span = await loadReleaseSpan(reader, {
    target_repository: "fongap-labs/app-source",
    source_repository: "fongap-labs/app-source",
    source_sha: head,
    default_branch: "main",
    release_key: "web",
    root: "projects/web",
    filesForCommit: async (sha: string) =>
      sha === head ? ["projects/web/form.ts"] : ["other/file.ts"],
  });
  assert.equal(span.base_version, "0.4.0");
  assert.deepEqual(span.changes, [{ type: "fix", attributes: [], summary: "the web form" }]);
  assert.deepEqual(bumpForChanges(span.changes), "patch");
  assert.equal(nextVersion(span.base_version, "patch"), "0.4.1");
});
