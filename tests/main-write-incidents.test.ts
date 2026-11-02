import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubHttpError } from "../scripts/github-api.ts";
import {
  assertNoOpenMainWriteIncidents,
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
