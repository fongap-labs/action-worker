import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  handleDirectWebhook,
  type IngressDatabase,
  type IngressEnvironment,
  type IngressStatement,
  ingressCronTelemetry,
  reconcileIngressCron,
  retryPendingDeliveries,
} from "../scripts/direct-event-ingress.ts";

const webhookSecret = "test-only-native-sqlite-integration-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appSigningKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const firstDelivery = "12345678-1234-4123-8123-123456789abc";
const secondDelivery = "87654321-4321-4123-8123-abcdefabcdef";

/**
 * Exercise the *production SQL statements* through the same D1-like methods
 * called by the webhook handler. No in-memory Maps or SQL branching stubs.
 */
class NativeSqliteInbox implements IngressDatabase {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(
      readFileSync(new URL("../docs/direct-event-ingress.sql", import.meta.url), "utf8")
    );
  }

  prepare(sql: string): IngressStatement {
    const query = this.database.prepare(sql);
    let bound: (string | number | null)[] = [];
    const adapter: IngressStatement = {
      bind(...values) {
        bound = values;
        return adapter;
      },
      async first<T>(): Promise<T | null> {
        return (query.get(...bound) ?? null) as unknown as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: query.all(...bound) as unknown as T[] };
      },
      async run(): Promise<unknown> {
        return query.run(...bound);
      },
    };
    return adapter;
  }

  close(): void {
    this.database.close();
  }
}

function environment(inbox: NativeSqliteInbox): IngressEnvironment {
  return {
    AW_INGRESS_DB: inbox,
    AW_GITHUB_WEBHOOK_SECRET: webhookSecret,
    AW_GITHUB_APP_ID: "42",
    AW_GITHUB_APP_INSTALLATION_ID: "101",
    AW_GITHUB_APP_PRIVATE_KEY: appSigningKey,
    AW_CONTROL_REPOSITORY: "fongap-labs/action-worker",
  };
}

function signedPush(
  deliveryId: string,
  before = "a".repeat(40),
  signatureSecret = webhookSecret
): Request {
  const body = JSON.stringify({
    installation: { id: 101 },
    repository: {
      full_name: "fongap-labs/workflow-fixture",
      default_branch: "main",
      owner: { login: "fongap-labs" },
    },
    ref: "refs/heads/main",
    before,
    after: "b".repeat(40),
    deleted: false,
  });
  const digest = createHmac("sha256", signatureSecret).update(body).digest("hex");
  return new Request("https://ingress.invalid/webhook", {
    method: "POST",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=" + digest,
    },
    body,
  });
}

function githubApi(options: { failDispatches?: number } = {}): {
  fetcher: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let failuresLeft = options.failDispatches ?? 0;
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    calls.push(path);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    if (path.endsWith("/access_tokens")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["action-worker"],
        permissions: { contents: "write" },
      });
      return Response.json({ token: "synthetic-installation-token" }, { status: 201 });
    }
    if (path.endsWith("/dispatches")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        event_type: "run-intake",
        client_payload: {},
      });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected GitHub API request");
  };
  return { fetcher, calls };
}

test("signed webhook to native SQL inbox to scoped GitHub dispatch survives duplicate replay", async () => {
  const inbox = new NativeSqliteInbox();
  try {
    const env = environment(inbox);
    const api = githubApi();
    assert.equal(
      (await handleDirectWebhook(signedPush(firstDelivery), env, api.fetcher)).status,
      202
    );
    const accepted = inbox.database
      .prepare("SELECT delivery_id, delivered_ms, lease_until_ms FROM webhook_deliveries")
      .get();
    assert.equal(accepted?.delivery_id, firstDelivery);
    assert.equal(typeof accepted?.delivered_ms, "number");
    assert.equal(accepted?.lease_until_ms, 0);
    assert.equal(api.calls.length, 2);

    // GitHub signs the body but not the delivery header; both must dedupe.
    assert.equal(
      (await handleDirectWebhook(signedPush(secondDelivery), env, api.fetcher)).status,
      202
    );
    assert.equal(
      (await handleDirectWebhook(signedPush(firstDelivery), env, api.fetcher)).status,
      202
    );
    assert.equal(
      inbox.database.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").get()?.count,
      1
    );
    assert.equal(api.calls.length, 2);

    assert.equal(
      (await handleDirectWebhook(signedPush(firstDelivery, "c".repeat(40)), env, api.fetcher))
        .status,
      409
    );
    assert.equal(
      (
        await handleDirectWebhook(
          signedPush(secondDelivery, "d".repeat(40), "incorrect-key"),
          env,
          api.fetcher
        )
      ).status,
      401
    );
    assert.equal(api.calls.length, 2);
  } finally {
    inbox.close();
  }
});

test("transient GitHub failure keeps real SQL lease; Cron resumes without duplicate completion", async () => {
  const inbox = new NativeSqliteInbox();
  try {
    const env = environment(inbox);
    const api = githubApi({ failDispatches: 1 });
    const first = await handleDirectWebhook(signedPush(firstDelivery), env, api.fetcher);
    assert.equal(first.status, 503);
    const row = inbox.database
      .prepare("SELECT delivered_ms, lease_until_ms FROM webhook_deliveries WHERE delivery_id = ?")
      .get(firstDelivery);
    assert.equal(row?.delivered_ms, null);
    assert.ok(Number(row?.lease_until_ms) > Date.now());

    assert.equal(await retryPendingDeliveries(env, api.fetcher), 0);
    assert.equal(api.calls.length, 2);
    // Simulate the elapsed lease on SQLite; do not sleep or bypass claim SQL.
    inbox.database
      .prepare("UPDATE webhook_deliveries SET lease_until_ms = 0 WHERE delivery_id = ?")
      .run(firstDelivery);
    assert.equal(await retryPendingDeliveries(env, api.fetcher), 1);
    assert.equal(api.calls.length, 4);
    assert.equal(
      typeof inbox.database
        .prepare("SELECT delivered_ms FROM webhook_deliveries WHERE delivery_id = ?")
        .get(firstDelivery)?.delivered_ms,
      "number"
    );
    assert.equal(await retryPendingDeliveries(env, api.fetcher), 0);
    assert.equal(api.calls.length, 4);
  } finally {
    inbox.close();
  }
});

test("Cron emits only aggregate backlog telemetry and retains pending retries", async () => {
  const inbox = new NativeSqliteInbox();
  try {
    const env = environment(inbox);
    const api = githubApi({ failDispatches: 1 });
    const first = await handleDirectWebhook(signedPush(firstDelivery), env, api.fetcher);
    assert.equal(first.status, 503);
    const reports: string[] = [];
    assert.equal(await reconcileIngressCron(env, api.fetcher, (line) => reports.push(line)), 0);
    assert.equal(reports.length, 1);
    const waiting = JSON.parse(reports[0]!) as Record<string, unknown>;
    assert.equal(waiting.component, "direct-event-ingress");
    assert.equal(waiting.pending_count, 1);
    assert.equal(waiting.completed_count, 0);
    assert.equal(typeof waiting.oldest_pending_age_minutes, "number");

    inbox.database
      .prepare("UPDATE webhook_deliveries SET lease_until_ms = 0 WHERE delivery_id = ?")
      .run(firstDelivery);
    assert.equal(await reconcileIngressCron(env, api.fetcher, (line) => reports.push(line)), 1);
    const recovered = JSON.parse(reports[1]!) as Record<string, unknown>;
    assert.deepEqual(recovered, {
      component: "direct-event-ingress",
      completed_count: 1,
      pending_count: 0,
      oldest_pending_age_minutes: null,
    });
    const serialized = reports.join("\n");
    for (const forbidden of [
      webhookSecret,
      appSigningKey,
      "synthetic-installation-token",
      firstDelivery,
      "fongap-labs/workflow-fixture",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    inbox.close();
  }
});

test("invalid backlog summaries fail closed without logging untrusted database data", () => {
  assert.deepEqual(ingressCronTelemetry(0, { pending_count: 0, oldest_created_ms: null }, 1_000), {
    component: "direct-event-ingress",
    completed_count: 0,
    pending_count: 0,
    oldest_pending_age_minutes: null,
  });
  assert.deepEqual(
    ingressCronTelemetry(2, { pending_count: 1, oldest_created_ms: 60_000 }, 180_000),
    {
      component: "direct-event-ingress",
      completed_count: 2,
      pending_count: 1,
      oldest_pending_age_minutes: 2,
    }
  );
  for (const invalid of [
    null,
    { pending_count: -1, oldest_created_ms: 1 },
    { pending_count: 0, oldest_created_ms: 1 },
    { pending_count: 1, oldest_created_ms: null },
    { pending_count: Number.NaN, oldest_created_ms: null },
  ]) {
    assert.throws(() => ingressCronTelemetry(0, invalid), /backlog snapshot/);
  }
});

test("concurrent authentic requests contend on the same native SQLite atomic lease", async () => {
  const inbox = new NativeSqliteInbox();
  try {
    const env = environment(inbox);
    const api = githubApi();
    const responses = await Promise.all([
      handleDirectWebhook(signedPush(firstDelivery), env, api.fetcher),
      handleDirectWebhook(signedPush(firstDelivery), env, api.fetcher),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [202, 202]
    );
    assert.equal(api.calls.filter((path) => path.endsWith("/dispatches")).length, 1);
    assert.equal(
      inbox.database.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").get()?.count,
      1
    );
  } finally {
    inbox.close();
  }
});
