import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoOpenMainWriteIncidents,
  findIncidents,
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
      { async get(): Promise<unknown> { return [incident]; } },
      "org/private-repo"
    ),
    /Unresolved main write incident\(s\).*#128/
  );
});

test("a resolved incident no longer blocks an attestation", async () => {
  await assert.doesNotReject(
    assertNoOpenMainWriteIncidents(
      { async get(): Promise<unknown> { return []; } },
      "org/private-repo"
    )
  );
});

test("an untrusted outsider cannot block release by creating a similarly titled public issue", async () => {
  const issues = await findIncidents(
    { async get(): Promise<unknown> { return [{ ...incident, author_association: "NONE" }]; } },
    "org/public-repo",
    "open"
  );
  assert.deepEqual(issues, []);
});

test("incident discovery rejects unexpected API responses", async () => {
  await assert.rejects(
    findIncidents(
      { async get(): Promise<unknown> { return {}; } },
      "org/repo",
      "open"
    ),
    /Cannot verify main write incidents/
  );
});

test("repeated scans cannot duplicate an already recorded commit incident", async () => {
  assert.equal(incidentTitle(sha), `Main write incident: ${sha.slice(0, 12)}`);
  const shouldCreate = await shouldCreateIncident(
    { async get(): Promise<unknown> { return [{ ...incident, title: incidentTitle(sha), state: "closed" }]; } },
    "org/private-repo",
    sha
  );
  assert.equal(shouldCreate, false);
});
