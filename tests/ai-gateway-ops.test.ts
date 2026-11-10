import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  listWorkerSecretNames,
  putWorkerSecret,
  runOperations,
  validateSecretMutation,
} from "../scripts/ai-gateway-ops.ts";

const accountId = "0123456789abcdef0123456789abcdef";
const healthKey = "health-key-0123456789abcdef0123456789abcdef";
const perceptionAuthKey = "perception-auth-key-0123456789abcdef";
const mockEnv = {
  CLOUDFLARE_ACCOUNT_ID_OPS: accountId,
  CLOUDFLARE_API_TOKEN_OPS: "ops-token",
  AIG_DEPLOY_HEALTH_KEY: healthKey,
  AIG_PUBLIC_URL: "https://gateway.example.test",
  AIG_OPS_SECRET_VALUE: "upstream-secret",
};

function mockFetch(
  onRequest: (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1]
  ) => Promise<Response> | Response
): typeof fetch {
  return async (input, init) => onRequest(input, init);
}

const names = [
  { name: "AIG_DEPLOY_HEALTH_KEY", type: "secret_text" },
  { name: "AIG_ACCESS_KEY_AIR", type: "secret_text" },
];
const ok = (result: unknown) => Response.json({ success: true, result });
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/ai-gateway/secrets`;

test("inventory only returns Cloudflare secret names, never returned values", async () => {
  const received: string[] = [];
  const fetcher = mockFetch((input, init) => {
    received.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ops-token");
    return ok([
      ...names,
      { name: "AIG_TIER1_CREDENTIALS_01", type: "secret_text", text: "private-secret" },
    ]);
  });
  const result = await runOperations("inventory", "", mockEnv, fetcher);
  assert.deepEqual(result, [
    "AIG_ACCESS_KEY_AIR",
    "AIG_DEPLOY_HEALTH_KEY",
    "AIG_TIER1_CREDENTIALS_01",
  ]);
  assert.deepEqual(received, [endpoint]);
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});

test("operation inputs and dedicated Cloudflare credentials fail closed", async () => {
  const never = mockFetch(() => {
    throw new Error("unexpected network request");
  });
  await assert.rejects(runOperations("delete", "", mockEnv, never), /Unsupported/);
  await assert.rejects(
    runOperations("inventory", "AIG_ACCESS_KEY_AIR", mockEnv, never),
    /must not include/
  );
  await assert.rejects(
    runOperations("inventory", "", { ...mockEnv, CLOUDFLARE_API_TOKEN_OPS: "" }, never),
    /CLOUDFLARE_API_TOKEN_OPS/
  );
  await assert.rejects(
    runOperations("inventory", "", { ...mockEnv, CLOUDFLARE_ACCOUNT_ID_OPS: "wrong" }, never),
    /32-character/
  );
  await assert.rejects(putWorkerSecret("AW_CONTROL_TOKEN", mockEnv, never), /allowlist/);
  await assert.rejects(
    putWorkerSecret("AIG_ACCESS_KEY_AIR", { ...mockEnv, AIG_OPS_SECRET_VALUE: "" }, never),
    /AIG_OPS_SECRET_VALUE/
  );
  await assert.rejects(
    putWorkerSecret(
      "AIG_ACCESS_KEY_AIR",
      { ...mockEnv, AIG_PUBLIC_URL: "http://localhost" },
      never
    ),
    /HTTPS/
  );
  await assert.rejects(
    putWorkerSecret("AIG_ACCESS_KEY_AIR", { ...mockEnv, AIG_DEPLOY_HEALTH_KEY: "" }, never),
    /AIG_DEPLOY_HEALTH_KEY/
  );
});

test("dedicated deployment health credential cannot be weak or reused as an application key", () => {
  assert.throws(
    () =>
      validateSecretMutation("AIG_DEPLOY_HEALTH_KEY", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: "short",
      }),
    /32 URL-safe/
  );
  assert.throws(
    () =>
      validateSecretMutation("AIG_DEPLOY_HEALTH_KEY", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: "abc".repeat(20) + "/",
      }),
    /32 URL-safe/
  );
  assert.throws(
    () =>
      validateSecretMutation("AIG_ACCESS_KEY_AGENT", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: healthKey,
      }),
    /must not reuse/
  );
  assert.throws(() => validateSecretMutation("AIG_INFERENCE_AUTH_KEY", mockEnv), /32 characters/);
  assert.throws(
    () =>
      validateSecretMutation("AIG_PERCEPTION_AUTH_KEY", {
        ...mockEnv,
        AIG_OPS_WORKER_NAME: "ai-perception-center",
        AIG_OPS_SECRET_VALUE: "short",
      }),
    /32 characters/
  );
  assert.throws(
    () =>
      validateSecretMutation("AIG_TIER1_CREDENTIALS_01", {
        ...mockEnv,
        AIG_OPS_WORKER_NAME: "ai-inference-center",
        AIG_OPS_SECRET_VALUE: "x".repeat(4501),
      }),
    /size limit/
  );
});

test("put updates one secret via JSON API without uploading a Worker script", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher = mockFetch((input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    requests.push({ url, method });
    if (url === endpoint && method === "PUT") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ops-token");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        name: "AIG_ACCESS_KEY_AIR",
        text: "upstream-secret",
        type: "secret_text",
      });
      return ok({ name: "AIG_ACCESS_KEY_AIR", type: "secret_text" });
    }
    if (url === endpoint && method === "GET") return ok(names);
    if (url === "https://gateway.example.test/health" && method === "GET") {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${healthKey}`);
      return Response.json({ ready: true, nodes_total: 2, nodes_usable: 2 });
    }
    throw new Error("Unexpected request");
  });
  await putWorkerSecret("AIG_ACCESS_KEY_AIR", mockEnv, fetcher);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET", "PUT", "GET", "GET"]
  );
  assert.ok(
    requests.every((request) => request.url === endpoint || request.url.endsWith("/health"))
  );
});

test("rotating the health credential verifies with the newly written value", async () => {
  const replacement = "replacement-0123456789abcdef0123456789abcdef";
  const fetcher = mockFetch((input, init) => {
    if (String(input) === endpoint && init?.method === "PUT") {
      assert.equal(JSON.parse(String(init.body)).text, replacement);
      return ok({ name: "AIG_DEPLOY_HEALTH_KEY", type: "secret_text" });
    }
    if (String(input) === endpoint) return ok(names);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${replacement}`);
    return Response.json({ ready: true, nodes_total: 1, nodes_usable: 1 });
  });
  await putWorkerSecret(
    "AIG_DEPLOY_HEALTH_KEY",
    { ...mockEnv, AIG_OPS_SECRET_VALUE: replacement },
    fetcher
  );
});

test("Cloudflare API refusal and malformed responses fail closed without leaking values", async () => {
  const secret = "do-not-leak-private-secret";
  const refused = mockFetch(() =>
    Response.json(
      {
        success: false,
        errors: [{ message: secret }],
      },
      { status: 403 }
    )
  );
  await assert.rejects(
    putWorkerSecret("AIG_ACCESS_KEY_AIR", { ...mockEnv, AIG_OPS_SECRET_VALUE: secret }, refused),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("HTTP 403") &&
      !error.message.includes(secret)
  );
  const invalid = mockFetch(() => ok([{ name: "AIG_DEPLOY_HEALTH_KEY", type: "plain_text" }]));
  await assert.rejects(
    listWorkerSecretNames(mockEnv, invalid),
    /Unexpected Cloudflare secret inventory/
  );
  const malformed = mockFetch(() => new Response("invalid json", { status: 200 }));
  await assert.rejects(listWorkerSecretNames(mockEnv, malformed), /invalid JSON/);
});

test("health failure after a secret update is reported without falsely claiming rollback", async () => {
  const fetcher = mockFetch((input, init) => {
    if (String(input) === endpoint && init?.method === "PUT")
      return ok({ name: "AIG_ACCESS_KEY_AIR", type: "secret_text" });
    if (String(input) === endpoint) return ok(names);
    return Response.json({ ready: false, nodes_total: 3, nodes_usable: 0 });
  });
  await assert.rejects(
    putWorkerSecret("AIG_ACCESS_KEY_AIR", mockEnv, fetcher),
    /previous value via a separately approved operation/
  );
});

test("protected four-Worker inventory runs only pinned audited source on manual dispatch", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ai-gateway-ops.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /name: ai-gateway-ops/);
  assert.match(workflow, /- runtime-inventory/);
  assert.match(workflow, /if: inputs.operation == 'runtime-inventory'/);
  assert.match(workflow, /repository: fongap-labs\/ai-gateway/);
  assert.match(workflow, /path: ag-inspector/);
  assert.match(workflow, /persist-credentials: false/);
  const source = workflow.match(/ref: ([a-f0-9]{40})\n\s+path: ag-inspector/);
  const checked = workflow.match(/PINNED_INSPECTOR_SHA: ([a-f0-9]{40})/);
  assert.ok(source && checked);
  assert.equal(
    source[1],
    checked[1],
    "checkout and runtime verification use exactly one immutable SHA"
  );
  assert.match(workflow, /git -C ag-inspector rev-parse HEAD/);
  assert.match(workflow, /node ag-inspector\/scripts\/check-cloudflare-live-inventory\.mjs/);
  assert.match(workflow, /node ag-inspector\/scripts\/check-production-cutover-evidence\.mjs/);
  assert.match(workflow, /node ag-inspector\/scripts\/cloudflare-live-inventory\.mjs/);
  assert.match(
    workflow,
    /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN_SECONDARY \}\}/
  );
  assert.doesNotMatch(workflow, /node ag-inspector\/scripts\/cloudflare-live-inventory\.mjs --out/);
});

test("private center secret management has strict per-Worker allowlists", () => {
  const inference = { ...mockEnv, AIG_OPS_WORKER_NAME: "ai-inference-center" };
  const perception = { ...mockEnv, AIG_OPS_WORKER_NAME: "ai-perception-center" };
  const generation = { ...mockEnv, AIG_OPS_WORKER_NAME: "ai-generation-center" };
  assert.equal(validateSecretMutation("AIG_TIER1_CREDENTIALS_01", inference), "upstream-secret");
  assert.equal(validateSecretMutation("AIG_TIER1_CREDENTIALS_01", perception), "upstream-secret");
  assert.equal(
    validateSecretMutation("AIG_PERCEPTION_AUTH_KEY", {
      ...perception,
      AIG_OPS_SECRET_VALUE: perceptionAuthKey,
    }),
    perceptionAuthKey
  );
  assert.equal(validateSecretMutation("AIG_TIER2_CREDENTIALS_10", generation), "upstream-secret");
  for (const [name, env] of [
    ["AIG_GENERATION_AUTH_KEY", inference],
    ["AIG_PERCEPTION_AUTH_KEY", inference],
    ["AIG_INFERENCE_AUTH_KEY", generation],
    ["AIG_PERCEPTION_AUTH_KEY", generation],
    ["AIG_INFERENCE_AUTH_KEY", perception],
    ["AIG_GENERATION_AUTH_KEY", perception],
    ["AIG_ACCESS_KEY_AGENT", inference],
    ["AIG_ACCESS_KEY_AGENT", perception],
    ["AIG_DEPLOY_HEALTH_KEY", generation],
    ["AIG_DEPLOY_HEALTH_KEY", perception],
    ["AIG_TIER1_CREDENTIALS_01", mockEnv],
    ["AIG_TOKEN_ENCRYPTION_KEY", mockEnv],
    ["AIG_TIER3_CREDENTIALS_01", inference],
  ] as const) {
    assert.throws(() => validateSecretMutation(name, env), /allowlist/);
  }
  assert.throws(
    () =>
      validateSecretMutation("AIG_ACCESS_KEY_AIR", {
        ...mockEnv,
        AIG_OPS_WORKER_NAME: "some-other-worker",
      }),
    /outside the protected/
  );
  assert.throws(
    () =>
      validateSecretMutation("AIG_INFERENCE_AUTH_KEY", {
        ...inference,
        AIG_OPS_SECRET_VALUE: healthKey,
      }),
    /must not reuse the deployment health/
  );
});

test("Perception center Secret update stays private and never probes the Gateway", async () => {
  const worker = "ai-perception-center";
  const env = { ...mockEnv, AIG_OPS_WORKER_NAME: worker, AIG_PUBLIC_URL: "" };
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/secrets`;
  const requests: string[] = [];
  const fetcher = mockFetch((input, init) => {
    const target = String(input);
    requests.push(target);
    assert.equal(target, url, "Never contact public /health or another Worker");
    if (init?.method === "PUT") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        name: "AIG_PERCEPTION_AUTH_KEY",
        text: perceptionAuthKey,
        type: "secret_text",
      });
      return ok({ name: "AIG_PERCEPTION_AUTH_KEY", type: "secret_text" });
    }
    return ok([{ name: "AIG_PERCEPTION_AUTH_KEY", type: "secret_text" }]);
  });
  await putWorkerSecret(
    "AIG_PERCEPTION_AUTH_KEY",
    { ...env, AIG_OPS_SECRET_VALUE: perceptionAuthKey },
    fetcher
  );
  assert.deepEqual(requests, [url, url, url]);
  assert.deepEqual(await listWorkerSecretNames(env, fetcher), ["AIG_PERCEPTION_AUTH_KEY"]);
});

test("private center Secret update stays inside selected Worker and never invokes public health", async () => {
  const worker = "ai-inference-center";
  const env = { ...mockEnv, AIG_OPS_WORKER_NAME: worker, AIG_PUBLIC_URL: "" };
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/secrets`;
  const requests: string[] = [];
  const fetcher = mockFetch((input, init) => {
    const target = String(input);
    requests.push(target);
    assert.equal(target, url, "Never contact public /health or another Worker");
    if (init?.method === "PUT") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        name: "AIG_TIER2_CREDENTIALS_01",
        text: "upstream-secret",
        type: "secret_text",
      });
      return ok({ name: "AIG_TIER2_CREDENTIALS_01", type: "secret_text" });
    }
    return ok([{ name: "AIG_TIER2_CREDENTIALS_01", type: "secret_text" }]);
  });
  await putWorkerSecret("AIG_TIER2_CREDENTIALS_01", env, fetcher);
  assert.deepEqual(requests, [url, url, url]);
  assert.deepEqual(await listWorkerSecretNames(env, fetcher), ["AIG_TIER2_CREDENTIALS_01"]);
});

test("protected ops workflow requires explicit Worker choice for private center inventory and put", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ai-gateway-ops.yml", import.meta.url),
    "utf8"
  );
  assert.match(
    workflow,
    /options:\n\s+- ai-gateway\n\s+- ai-inference-center\n\s+- ai-perception-center\n\s+- ai-generation-center/
  );
  assert.match(workflow, /AIG_OPS_WORKER_NAME: \$\{\{ inputs.worker \}\}/);
  assert.doesNotMatch(workflow, /secret delete/);
});

test("code deployment uses the source-owned entrypoint, never the Secret operations workflow", () => {
  const ops = readFileSync(
    new URL("../.github/workflows/ai-gateway-ops.yml", import.meta.url),
    "utf8"
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-source-script.yml", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(ops, /deploy-center|private-center-release/);
  assert.doesNotMatch(ops, /cloudflare-wrangler\.mjs deploy|wrangler deploy/);
  assert.match(deploy, /node control\/scripts\/run-scoped-deploy\.ts/);
  assert.match(deploy, /DEPLOY_SOURCE_REPOSITORY/);
  assert.match(deploy, /DEPLOY_SOURCE_SHA/);
});
