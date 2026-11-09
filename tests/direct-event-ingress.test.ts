import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  handleDirectWebhook,
  type IngressDatabase,
  type IngressEnvironment,
  type IngressStatement,
  retryPendingDeliveries,
  verifyGithubSignature,
} from "../scripts/direct-event-ingress.ts";

const secret = "a-webhook-secret-used-only-by-tests";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPrivateKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const deliveryId = "12345678-1234-4123-8123-123456789abc";

type Row = {
  delivery_id: string;
  body_digest: string;
  installation_id: number;
  created_ms: number;
  lease_until_ms: number;
  delivered_ms: number | null;
};

class FakeDatabase implements IngressDatabase {
  readonly rows = new Map<string, Row>();

  prepare(sql: string): IngressStatement {
    let values: (string | number | null)[] = [];
    const statement: IngressStatement = {
      bind(...args) {
        values = args;
        return statement;
      },
      async run(): Promise<unknown> {
        if (sql.startsWith("INSERT OR IGNORE")) {
          const id = String(values[0]);
          const digest = String(values[1]);
          if (
            !database.rows.has(id) &&
            ![...database.rows.values()].some((row) => row.body_digest === digest)
          ) {
            database.rows.set(id, {
              delivery_id: id,
              body_digest: digest,
              installation_id: Number(values[2]),
              created_ms: Number(values[5]),
              lease_until_ms: 0,
              delivered_ms: null,
            });
          }
          return {};
        }
        if (sql.startsWith("UPDATE webhook_deliveries SET delivered_ms")) {
          const row = database.rows.get(String(values[1]));
          if (row) {
            row.delivered_ms = Number(values[0]);
            row.lease_until_ms = 0;
          }
          return {};
        }
        throw new Error("Unexpected SQL run");
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith("SELECT delivery_id, body_digest")) {
          const row = sql.endsWith("WHERE delivery_id = ?")
            ? database.rows.get(String(values[0]))
            : [...database.rows.values()].find((item) => item.body_digest === String(values[0]));
          return row ? ({ delivery_id: row.delivery_id, body_digest: row.body_digest } as T) : null;
        }
        if (!sql.includes("RETURNING delivery_id")) throw new Error("Unexpected SQL first");
        const row = database.rows.get(String(values[1]));
        if (!row || row.delivered_ms !== null || row.lease_until_ms > Number(values[2]))
          return null;
        row.lease_until_ms = Number(values[0]);
        return { delivery_id: row.delivery_id } as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (!sql.startsWith("SELECT delivery_id")) throw new Error("Unexpected SQL all");
        const results = [...database.rows.values()]
          .filter((row) => row.delivered_ms === null && row.lease_until_ms <= Number(values[0]))
          .sort((a, b) => a.lease_until_ms - b.lease_until_ms || a.created_ms - b.created_ms)
          .slice(0, 25)
          .map((row) => ({ delivery_id: row.delivery_id, installation_id: row.installation_id }));
        return { results: results as T[] };
      },
    };
    const database = this;
    return statement;
  }
}

function makeEnvironment(database = new FakeDatabase()): IngressEnvironment {
  return {
    AW_INGRESS_DB: database,
    AW_GITHUB_WEBHOOK_SECRET: secret,
    AW_GITHUB_APP_ID: "42",
    AW_GITHUB_APP_INSTALLATION_ID: "101",
    AW_GITHUB_APP_PRIVATE_KEY: testPrivateKey,
    AW_CONTROL_REPOSITORY: "fongap-labs/action-worker",
  };
}

function makePayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installation: { id: 101 },
    repository: {
      full_name: "fongap-labs/example",
      default_branch: "main",
      owner: { login: "fongap-labs" },
    },
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    deleted: false,
    ...fields,
  };
}

function makePullRequestPayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installation: { id: 101 },
    repository: {
      full_name: "fongap-labs/example",
      default_branch: "main",
      owner: { login: "fongap-labs" },
    },
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      base: { repo: { full_name: "fongap-labs/example" } },
    },
    ...fields,
  };
}

function signedRequest(
  payload: Record<string, unknown>,
  eventName = "push",
  delivery = deliveryId,
  signingSecret = secret
): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", signingSecret).update(body).digest("hex");
  return new Request("https://ingress.example/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": "sha256=" + signature,
      "x-github-delivery": delivery,
      "x-github-event": eventName,
    },
    body,
  });
}

function mockGithubApi(options: { failDispatch?: boolean } = {}): {
  fetcher: typeof fetch;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, body: JSON.parse(String(init?.body)) as unknown });
    if (path.endsWith("/access_tokens")) {
      return Response.json({ token: "test-scoped-app-token" }, { status: 201 });
    }
    if (path.endsWith("/dispatches")) {
      return new Response(null, { status: options.failDispatch ? 503 : 204 });
    }
    throw new Error("Unexpected GitHub API path");
  };
  return { fetcher, calls };
}

test("verifies exact raw bytes using GitHub sha256 signature", async () => {
  const body = new TextEncoder().encode("hello");
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(await verifyGithubSignature(body, signature, secret), true);
  assert.equal(
    await verifyGithubSignature(new TextEncoder().encode("hello!"), signature, secret),
    false
  );
  assert.equal(
    await verifyGithubSignature(body, signature.replace("sha256=", "sha1="), secret),
    false
  );
  assert.equal(await verifyGithubSignature(body, null, secret), false);
  assert.equal(await verifyGithubSignature(body, signature, ""), false);
});

test("accepts a verified default-branch push and dispatches only an empty intake heartbeat", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  const response = await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  assert.equal(response.status, 202);
  assert.equal(db.rows.get(deliveryId)?.delivered_ms !== null, true);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0]?.path, "https://api.github.com/app/installations/101/access_tokens");
  assert.deepEqual(api.calls[0]?.body, {
    repositories: ["action-worker"],
    permissions: { contents: "write" },
  });
  assert.equal(
    api.calls[1]?.path,
    "https://api.github.com/repos/fongap-labs/action-worker/dispatches"
  );
  assert.deepEqual(api.calls[1]?.body, { event_type: "run-intake", client_payload: {} });
});

test("delivery ID replay never dispatches twice once acknowledged", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  const duplicate = await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  assert.equal(duplicate.status, 202);
  assert.equal(api.calls.length, 2);
  assert.equal(db.rows.size, 1);
});

test("unsigned delivery header changes cannot replay an already accepted signed body", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  const replacementId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const replay = await handleDirectWebhook(
    signedRequest(makePayload(), "push", replacementId),
    env,
    api.fetcher
  );
  assert.equal(replay.status, 202);
  assert.equal(db.rows.size, 1);
  assert.equal(db.rows.has(replacementId), false);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/dispatches")).length, 1);
});

test("the same delivery ID cannot be reused with a different signed body", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  const conflicting = await handleDirectWebhook(
    signedRequest(makePayload({ before: "c".repeat(40) })),
    env,
    api.fetcher
  );
  assert.equal(conflicting.status, 409);
  assert.equal(db.rows.size, 1);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/dispatches")).length, 1);
});

test("authentication, installation, owner and event filters fail closed", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  const wrongSignature = signedRequest(makePayload(), "push", deliveryId, "wrong-secret");
  assert.equal((await handleDirectWebhook(wrongSignature, env, api.fetcher)).status, 401);
  assert.equal(
    (
      await handleDirectWebhook(
        signedRequest(makePayload({ installation: { id: 404 } })),
        env,
        api.fetcher
      )
    ).status,
    403
  );
  assert.equal(
    (
      await handleDirectWebhook(
        signedRequest(
          makePayload({ repository: { full_name: "other/repo", owner: { login: "other" } } })
        ),
        env,
        api.fetcher
      )
    ).status,
    403
  );
  assert.equal(
    (
      await handleDirectWebhook(
        signedRequest(makePayload({ ref: "refs/heads/topic" })),
        env,
        api.fetcher
      )
    ).status,
    200
  );
  assert.equal(
    (await handleDirectWebhook(signedRequest(makePayload(), "issues"), env, api.fetcher)).status,
    200
  );
  assert.equal(
    (await handleDirectWebhook(signedRequest(makePayload(), "push", "bad-id"), env, api.fetcher))
      .status,
    400
  );
  assert.equal(db.rows.size, 0);
  assert.equal(api.calls.length, 0);
});

test("pull-request changes wake Intake but unrelated actions do not", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  const opened = await handleDirectWebhook(
    signedRequest(makePullRequestPayload(), "pull_request"),
    env,
    api.fetcher
  );
  assert.equal(opened.status, 202);
  const closed = await handleDirectWebhook(
    signedRequest(
      makePullRequestPayload({ action: "closed" }),
      "pull_request",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    ),
    env,
    api.fetcher
  );
  assert.equal(closed.status, 200);
  assert.equal(db.rows.size, 1);
});

test("an unsigned event header cannot reclassify a signed push, issue or PR body", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  const openedIssue = {
    ...makePayload({ action: "opened" }),
    number: 42,
    issue: { number: 42 },
  };
  assert.equal(
    (
      await handleDirectWebhook(
        signedRequest(makePayload({ action: "opened" }), "pull_request"),
        env,
        api.fetcher
      )
    ).status,
    200
  );
  assert.equal(
    (await handleDirectWebhook(signedRequest(openedIssue, "pull_request"), env, api.fetcher))
      .status,
    200
  );
  assert.equal(
    (await handleDirectWebhook(signedRequest(makePullRequestPayload(), "push"), env, api.fetcher))
      .status,
    200
  );
  assert.equal(
    (await handleDirectWebhook(signedRequest(makePayload({ after: undefined })), env, api.fetcher))
      .status,
    200
  );
  assert.equal(db.rows.size, 0);
  assert.equal(api.calls.length, 0);
});

test("PR events require matching signed number and target repository identities", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  const mismatchedNumber = makePullRequestPayload({ number: 43 });
  const mismatchedBase = makePullRequestPayload({
    pull_request: { number: 42, base: { repo: { full_name: "fongap-labs/other" } } },
  });
  assert.equal(
    (await handleDirectWebhook(signedRequest(mismatchedNumber, "pull_request"), env, api.fetcher))
      .status,
    200
  );
  assert.equal(
    (await handleDirectWebhook(signedRequest(mismatchedBase, "pull_request"), env, api.fetcher))
      .status,
    200
  );
  assert.equal(db.rows.size, 0);
  assert.equal(api.calls.length, 0);
});

test("ambiguous GitHub dispatch failures remain durable and are retried by cron", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const failingApi = mockGithubApi({ failDispatch: true });
  const first = await handleDirectWebhook(signedRequest(makePayload()), env, failingApi.fetcher);
  assert.equal(first.status, 503);
  const pending = db.rows.get(deliveryId);
  assert.equal(pending?.delivered_ms, null);
  assert.equal(pending?.lease_until_ms !== 0, true);
  assert.equal(await retryPendingDeliveries(env, mockGithubApi().fetcher), 0);
  if (!pending) throw new Error("Missing pending delivery");
  pending.lease_until_ms = 0;
  const successfulApi = mockGithubApi();
  assert.equal(await retryPendingDeliveries(env, successfulApi.fetcher), 1);
  assert.equal(successfulApi.calls.length, 2);
  assert.equal(pending.delivered_ms !== null, true);
  assert.equal(await retryPendingDeliveries(env, successfulApi.fetcher), 0);
});

test("cron prioritizes never-tried deliveries over an older failing batch", async () => {
  const db = new FakeDatabase();
  const now = Date.now();
  for (let index = 0; index < 30; index += 1) {
    const id = `delivery-${index}`;
    db.rows.set(id, {
      delivery_id: id,
      body_digest: `digest-${index}`,
      installation_id: 101,
      created_ms: index + 1,
      lease_until_ms: index < 25 ? now - 1_000 : 0,
      delivered_ms: null,
    });
  }
  const api = mockGithubApi({ failDispatch: true });
  assert.equal(await retryPendingDeliveries(makeEnvironment(db), api.fetcher), 0);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/dispatches")).length, 25);
  // All five newer records must have been attempted despite 25 older poison deliveries.
  for (let index = 25; index < 30; index += 1) {
    assert.equal((db.rows.get(`delivery-${index}`)?.lease_until_ms ?? 0) > now, true);
  }
  assert.equal(db.rows.get("delivery-20")?.lease_until_ms, now - 1_000);
});

test("cron cannot mint credentials for an installation other than the configured App", async () => {
  const db = new FakeDatabase();
  db.rows.set(deliveryId, {
    delivery_id: deliveryId,
    body_digest: "stale-installation-record",
    installation_id: 999,
    created_ms: 1,
    lease_until_ms: 0,
    delivered_ms: null,
  });
  const api = mockGithubApi();
  assert.equal(await retryPendingDeliveries(makeEnvironment(db), api.fetcher), 0);
  assert.equal(api.calls.length, 0);
  assert.equal(db.rows.get(deliveryId)?.delivered_ms, null);
});

test("concurrent requests cannot both claim the same delivery lease", async () => {
  const db = new FakeDatabase();
  const env = makeEnvironment(db);
  const api = mockGithubApi();
  const [one, two] = await Promise.all([
    handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher),
    handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher),
  ]);
  assert.equal(one.status, 202);
  assert.equal(two.status, 202);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/dispatches")).length, 1);
});

test("native GitHub App PKCS#1 PEM is rejected before inbox writes or token requests", async () => {
  const db = new FakeDatabase();
  const env = {
    ...makeEnvironment(db),
    AW_GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
  };
  const api = mockGithubApi();
  const response = await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  assert.equal(response.status, 503);
  assert.equal(db.rows.size, 0);
  assert.equal(api.calls.length, 0);
  assert.equal(await retryPendingDeliveries(env, api.fetcher).then(() => false, () => true), true);
});

test("PEM with a malformed end marker fails closed without exposing key material", async () => {
  const db = new FakeDatabase();
  const env = {
    ...makeEnvironment(db),
    AW_GITHUB_APP_PRIVATE_KEY: testPrivateKey.replace("-----END ", "-----INVALID "),
  };
  const api = mockGithubApi();
  const response = await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("PRIVATE"), false);
  assert.equal(db.rows.size, 0);
  assert.equal(api.calls.length, 0);
});

test("missing configuration never mints credentials or writes to the inbox", async () => {
  const db = new FakeDatabase();
  const env = { ...makeEnvironment(db), AW_GITHUB_APP_PRIVATE_KEY: "" };
  const api = mockGithubApi();
  const response = await handleDirectWebhook(signedRequest(makePayload()), env, api.fetcher);
  assert.equal(response.status, 503);
  assert.equal(db.rows.size, 0);
  assert.equal(api.calls.length, 0);
});
