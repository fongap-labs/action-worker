import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRepairIssue } from "../scripts/repair-issue-binding.ts";

const repository = "fongap-labs/action-worker";
const head = "b".repeat(40);
const marker = `<!-- aw-repair-failure:v1 run=42 sha=${head} -->`;

function issue(number: number, body: string | null, isPull = false) {
  return {
    number,
    state: "open",
    body,
    ...(isPull ? { pull_request: { url: "https://api.github.com/pr/999" } } : {}),
  };
}

test("exact run and HEAD marker resolves one open Issue, never a PR or title hint", async () => {
  const seen: string[] = [];
  const result = await resolveRepairIssue(
    {
      async get(path) {
        seen.push(path);
        return [
          issue(10, marker, true),
          issue(11, "CI failed run=42 with a different source"),
          issue(12, `Summary\n${marker}\nFull report link`),
          issue(13, "<!-- aw-repair-failure:v1 run=99 sha=" + head + " -->"),
        ];
      },
    },
    repository,
    42,
    head
  );
  assert.equal(result, 12);
  assert.deepEqual(seen, [`repos/${repository}/issues?state=open&per_page=100&page=1`]);
});

test("a matching Issue is not returned before the complete bounded scan", async () => {
  const seen: string[] = [];
  const result = await resolveRepairIssue(
    {
      async get(path) {
        seen.push(path);
        return path.endsWith("page=1")
          ? [issue(1, marker), ...Array.from({ length: 99 }, (_, i) => issue(i + 2, null))]
          : [];
      },
    },
    repository,
    42,
    head
  );
  assert.equal(result, 1);
  assert.equal(seen.length, 2);
});

test("conflicting matching Issues fail closed rather than choosing the first", async () => {
  await assert.rejects(
    resolveRepairIssue(
      {
        async get() {
          return [issue(1, marker), issue(2, marker)];
        },
      },
      repository,
      42,
      head
    ),
    /Multiple Issues/
  );
});

test("empty and unrelated Issue lists cannot invent a match", async () => {
  const reader = {
    async get() {
      return [
        issue(1, "Run 42 " + head),
        issue(2, marker.replace("run=42", "run=43")),
        issue(3, null),
        issue(4, marker.replace(head, "a".repeat(40))),
      ];
    },
  };
  assert.equal(await resolveRepairIssue(reader, repository, 42, head), null);
});

test("untrusted Issue metadata, duplicate markers, and truncated pages are rejected", async () => {
  const data: unknown[] = [
    [{ number: 1, state: "closed", body: marker }],
    [issue(1, marker), issue(1, null)],
    [issue(1, marker + "\n" + marker)],
    [issue(1, "a".repeat(65_537))],
    { issues: [issue(1, marker)] },
  ];
  for (const page of data) {
    await assert.rejects(
      resolveRepairIssue(
        {
          async get() {
            return page;
          },
        },
        repository,
        42,
        head
      )
    );
  }
  await assert.rejects(
    resolveRepairIssue(
      {
        async get() {
          return Array.from({ length: 100 }, (_, i) => issue(i + 1, null));
        },
      },
      repository,
      42,
      head
    ),
    /page budget/
  );
});

test("invalid repository, run ID, and SHA are rejected without network calls", async () => {
  let reads = 0;
  const reader = {
    async get(): Promise<unknown> {
      reads += 1;
      return [];
    },
  };
  for (const [name, id, sha] of [
    ["private/../source", 42, head],
    [repository, 0, head],
    [repository, Number.MAX_SAFE_INTEGER + 1, head],
    [repository, 42, "invalid"],
  ] as const) {
    await assert.rejects(resolveRepairIssue(reader, name, id, sha), /invalid failure identity/);
  }
  assert.equal(reads, 0);
});

test("a later read error cannot return an earlier match or expose Issue bodies", async () => {
  const original = console.log;
  let logs = 0;
  console.log = () => {
    logs += 1;
  };
  try {
    await assert.rejects(
      resolveRepairIssue(
        {
          async get(path) {
            if (path.endsWith("page=1")) {
              return [
                issue(1, marker),
                ...Array.from({ length: 99 }, (_, i) => issue(i + 2, null)),
              ];
            }
            throw new Error("HTTP 403 on later page");
          },
        },
        repository,
        42,
        head
      ),
      /403/
    );
    assert.equal(logs, 0);
  } finally {
    console.log = original;
  }
});
