import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { inspectBranchDrift, summarizeBranchDrift } from "../scripts/audit-branch-drift.ts";

const repository = "fongap-labs/example";
const main = "a".repeat(40);
const dev = "b".repeat(40);
const prefix = `repos/${repository}`;

function readerFor(ahead: number, behind: number, moved = false) {
  const paths: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      paths.push(path);
      if (path === `${prefix}/branches/main`) {
        return { name: "main", commit: { sha: main } };
      }
      if (path === `${prefix}/branches/dev`) {
        const repeated = paths.filter((item) => item === path).length > 1;
        return {
          name: "dev",
          commit: { sha: moved && repeated ? "c".repeat(40) : ahead || behind ? dev : main },
        };
      }
      assert.equal(path, `${prefix}/compare/${main}...${dev}?per_page=1`);
      return {
        base_commit: { sha: main },
        ahead_by: ahead,
        behind_by: behind,
        status: ahead && behind ? "diverged" : ahead ? "ahead" : "behind",
      };
    },
  };
  return { reader, paths };
}

test("branch comparison pins both SHAs and reports direction without transfer", async () => {
  for (const [ahead, behind, state] of [
    [0, 0, "identical"],
    [2, 0, "dev-ahead"],
    [0, 3, "main-ahead"],
    [2, 3, "diverged"],
  ] as const) {
    const { reader, paths } = readerFor(ahead, behind);
    assert.deepEqual(await inspectBranchDrift(reader, repository), { state, ahead, behind });
    assert.equal(
      paths.filter((path) => path.includes("/compare/")).length,
      ahead || behind ? 1 : 0
    );
  }
  assert.deepEqual(await inspectBranchDrift(readerFor(1, 2, true).reader, repository), {
    state: "moving",
  });
});

test("invalid comparison or unavailable repository does not report a clean branch", async () => {
  const { reader } = readerFor(2, 3);
  const invalid = {
    async get(path: string) {
      return path.includes("/compare/")
        ? { base_commit: { sha: main }, ahead_by: 0, behind_by: 0, status: "identical" }
        : reader.get(path);
    },
  };
  assert.deepEqual(await inspectBranchDrift(invalid, repository), { state: "invalid" });
  const summary = await summarizeBranchDrift(
    {
      async get() {
        throw new Error("private identity must not appear in logs");
      },
    },
    ["fongap-labs/private-example"]
  );
  assert.equal(summary.incomplete, 1);
  assert.doesNotMatch(summary.lines.join("\n"), /private-example|private identity/);
});

test("scheduled observation uses only scoped read credentials and opt-in metrics", () => {
  const workflow = parse(readFileSync(".github/workflows/intake.yml", "utf8")) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; if?: string; env?: unknown; run?: string }> }
    >;
  };
  const step = workflow.jobs["main-writes"]?.steps.find(
    (item) => item.name === "Observe managed branch differences"
  );
  assert.equal(step?.run, "node scripts/audit-branch-drift.ts");
  assert.match(step?.if ?? "", /github.event_name == 'schedule'/);
  assert.deepEqual(step?.env, {
    AW_NATIVE_TOKEN: "${{ github.token }}",
    AW_GITHUB_API_METRICS: "1",
    AW_CONTROL_TOKEN: "${{ steps.control_read_app.outputs.token }}",
  });
});
