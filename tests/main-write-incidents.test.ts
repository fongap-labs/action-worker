import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubHttpError } from "../scripts/github-api.ts";
import {
  assertNoOpenMainWriteIncidents,
  assertNoOpenManagedWriteIncidents,
  findActiveIncidents,
  findIncidents,
  IncidentAccessError,
  incidentTitle,
  shouldCreateIncident,
} from "../scripts/main-write-incidents.ts";

const sha = "a".repeat(40);
const incident = {
  number: 128,
  state: "open",
  title: "Main write incident: PR #126 merged without verified governance",
  author_association: "MEMBER",
};

test("an unresolved maintainer incident blocks the official main write attestation", async () => {
  await assert.rejects(
    assertNoOpenMainWriteIncidents(
      {
        async get(): Promise<unknown> {
          return [incident];
        },
      },
      "org/private-repo"
    ),
    /Unresolved main write incident\(s\).*#128/
  );
});

test("historical incidents do not expire without explicit resolution", async () => {
  const oldIncident = { ...incident, created_at: "2001-01-01T00:00:00Z" };
  await assert.rejects(
    assertNoOpenMainWriteIncidents(
      {
        async get(path: string): Promise<unknown> {
          return path.includes("/comments?") ? [] : [oldIncident];
        },
      },
      "org/private-repo"
    ),
    /Unresolved main write incident/
  );
});

test("a resolved incident no longer blocks an attestation", async () => {
  await assert.doesNotReject(
    assertNoOpenMainWriteIncidents(
      {
        async get(): Promise<unknown> {
          return [];
        },
      },
      "org/private-repo"
    )
  );
});

test("an untrusted outsider cannot block release by creating a similarly titled public issue", async () => {
  const issues = await findIncidents(
    {
      async get(): Promise<unknown> {
        return [{ ...incident, author_association: "NONE" }];
      },
    },
    "org/public-repo",
    "open"
  );
  assert.deepEqual(issues, []);
});

test("official Action Worker bot incidents remain blocking even without member association", async () => {
  const botIncident = {
    ...incident,
    number: 129,
    author_association: "NONE",
    user: { login: "fongap-action-worker[bot]", type: "Bot" },
  };
  await assert.rejects(
    assertNoOpenMainWriteIncidents(
      {
        async get(path: string): Promise<unknown> {
          return path.includes("/comments?") ? [] : [botIncident];
        },
      },
      "org/private-repo"
    ),
    /Unresolved main write incident\(s\).*#129/
  );
  assert.equal(
    await shouldCreateIncident(
      {
        async get(): Promise<unknown> {
          return [{ ...botIncident, state: "closed", title: incidentTitle(sha) }];
        },
      },
      "org/private-repo",
      sha
    ),
    false
  );
});

test("current fongap-bot incidents remain blocking and are not recreated", async () => {
  const botIncident = {
    ...incident,
    number: 482,
    title: incidentTitle(sha),
    author_association: "NONE",
    user: { login: "fongap-bot[bot]", type: "Bot" },
  };
  const reader = {
    async get(path: string): Promise<unknown> {
      return path.includes("/comments?") ? [] : [botIncident];
    },
  };
  assert.equal(await shouldCreateIncident(reader, "org/private-repo", sha), false);
  await assert.rejects(
    assertNoOpenMainWriteIncidents(reader, "org/private-repo"),
    /Unresolved main write incident\(s\).*#482/
  );
  const untrusted = await findIncidents(
    {
      async get(): Promise<unknown> {
        return [{ ...botIncident, user: { login: "fongap-bot[bot]", type: "User" } }];
      },
    },
    "org/private-repo",
    "open"
  );
  assert.deepEqual(untrusted, []);
});

test("a user pretending to be the Action Worker bot cannot create a trusted incident", async () => {
  const issues = await findIncidents(
    {
      async get(): Promise<unknown> {
        return [
          {
            ...incident,
            author_association: "NONE",
            user: { login: "fongap-action-worker[bot]", type: "User" },
          },
        ];
      },
    },
    "org/public-repo",
    "open"
  );
  assert.deepEqual(issues, []);
});

test("incident discovery rejects unexpected API responses", async () => {
  await assert.rejects(
    findIncidents(
      {
        async get(): Promise<unknown> {
          return {};
        },
      },
      "org/repo",
      "open"
    ),
    /Cannot verify main write incidents/
  );
});

test("repeated scans cannot duplicate an already recorded commit incident", async () => {
  assert.equal(incidentTitle(sha), `Main write incident: ${sha.slice(0, 12)}`);
  const shouldCreate = await shouldCreateIncident(
    {
      async get(): Promise<unknown> {
        return [{ ...incident, title: incidentTitle(sha), state: "closed" }];
      },
    },
    "org/private-repo",
    sha
  );
  assert.equal(shouldCreate, false);
});

test("a private Issues permission failure blocks audit with an actionable credential diagnostic", async () => {
  for (const status of [403, 404]) {
    await assert.rejects(
      assertNoOpenMainWriteIncidents(
        {
          async get(): Promise<unknown> {
            throw new GithubHttpError(status);
          },
        },
        "fongap-labs/internal-vault"
      ),
      (error: unknown) =>
        error instanceof IncidentAccessError &&
        error.message.includes("fongap-labs/internal-vault") &&
        error.message.includes(`HTTP ${status}`) &&
        error.message.includes("AW_CONTROL_TOKEN") &&
        error.message.includes("Issues: read and write")
    );
  }
});

test("transient incident-read errors remain distinguishable from missing permission", async () => {
  await assert.rejects(
    findIncidents(
      {
        async get(): Promise<unknown> {
          throw new GithubHttpError(503);
        },
      },
      "fongap-labs/internal-vault",
      "open"
    ),
    (error: unknown) => error instanceof GithubHttpError && error.status === 503
  );
});

test("main and dev incidents and deduplication are isolated even for the same SHA", async () => {
  const mainIncident = { ...incident, number: 1, title: incidentTitle(sha) };
  const devIncident = { ...incident, number: 2, title: incidentTitle(sha, "dev") };
  const repository = "org/private-repo";
  assert.equal(devIncident.title, `Dev write incident: ${sha.slice(0, 12)}`);
  const issues = [mainIncident, devIncident];
  const reader = {
    async get(path: string): Promise<unknown> {
      return path.includes("/comments?") ? [] : issues;
    },
  };
  assert.deepEqual(await findActiveIncidents(reader, repository), [mainIncident]);
  assert.deepEqual(await findActiveIncidents(reader, repository, "dev"), [devIncident]);
  await assert.rejects(assertNoOpenMainWriteIncidents(reader, repository), /#1/);
  await assert.rejects(assertNoOpenManagedWriteIncidents(reader, repository, "dev"), /#2/);
  issues.pop();
  assert.equal(await shouldCreateIncident(reader, repository, sha), false);
  assert.equal(await shouldCreateIncident(reader, repository, sha, "dev"), true);
  await assert.doesNotReject(assertNoOpenManagedWriteIncidents(reader, repository, "dev"));
  issues.splice(0, 1, devIncident);
  assert.equal(await shouldCreateIncident(reader, repository, sha), true);
  assert.equal(await shouldCreateIncident(reader, repository, sha, "dev"), false);
  await assert.doesNotReject(assertNoOpenMainWriteIncidents(reader, repository));
});

test("resolving a main incident cannot resolve a dev incident", async () => {
  const repository = "org/private-repo";
  const mainIncident = { ...incident, number: 1, title: incidentTitle(sha) };
  const devIncident = { ...incident, number: 2, title: incidentTitle(sha, "dev") };
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path.includes("/issues/1/comments?")) {
        return [{ body: "/resolve", author_association: "OWNER" }];
      }
      if (path.includes("/issues/2/comments?")) return [];
      return [mainIncident, devIncident];
    },
  };
  await assert.doesNotReject(assertNoOpenMainWriteIncidents(reader, repository));
  await assert.rejects(assertNoOpenManagedWriteIncidents(reader, repository, "dev"), /#2/);
});

test("large repositories do not lose incidents beyond the first thousand issue rows", async () => {
  const repository = "org/large-repo";
  const old = { ...incident, title: incidentTitle(sha, "dev"), state: "closed" };
  let pages = 0;
  const reader = {
    async get(path: string): Promise<unknown> {
      pages++;
      assert.equal(path, `repos/${repository}/issues?state=all&per_page=100&page=${pages}`);
      if (pages === 22) return [old];
      return Array.from({ length: 100 }, (_, index) => ({
        number: pages * 100 + index,
        pull_request: {},
      }));
    },
  };
  assert.equal(await shouldCreateIncident(reader, repository, sha, "dev"), false);
  assert.equal(pages, 22);
});
