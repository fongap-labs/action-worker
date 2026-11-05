import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listWorkerSecretNames,
  putWorkerSecret,
  runOperations,
  validateSecretMutation,
} from "../scripts/ai-gateway-ops.ts";

const accountId = "0123456789abcdef0123456789abcdef";
const healthKey = "health-key-0123456789abcdef0123456789abcdef";
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
    putWorkerSecret("AIG_ACCESS_KEY_AIR", { ...mockEnv, AIG_PUBLIC_URL: "http://localhost" }, never),
    /HTTPS/
  );
  await assert.rejects(
    putWorkerSecret("AIG_ACCESS_KEY_AIR", { ...mockEnv, AIG_DEPLOY_HEALTH_KEY: "" }, never),
    /AIG_DEPLOY_HEALTH_KEY/
  );
});

test("dedicated deployment health credential cannot be weak or reused as an application key", () => {
  assert.throws(() => validateSecretMutation("AIG_DEPLOY_HEALTH_KEY", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: "short",
      }), /32 URL-safe/);
  assert.throws(() => validateSecretMutation("AIG_DEPLOY_HEALTH_KEY", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: "abc".repeat(20) + "/",
      }), /32 URL-safe/);
  assert.throws(() => validateSecretMutation("AIG_ACCESS_KEY_AGENT", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: healthKey,
      }), /must not reuse/);
  assert.throws(() => validateSecretMutation("AIG_INFERENCE_AUTH_KEY", mockEnv), /32 characters/);
  assert.throws(() => validateSecretMutation("AIG_TIER1_CREDENTIALS_01", {
        ...mockEnv,
        AIG_OPS_SECRET_VALUE: "x".repeat(4501),
      }), /size limit/);
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
  await putWorkerSecret("AIG_DEPLOY_HEALTH_KEY", { ...mockEnv, AIG_OPS_SECRET_VALUE: replacement }, fetcher);
});

test("Cloudflare API refusal and malformed responses fail closed without leaking values", async () => {
  const secret = "do-not-leak-private-secret";
  const refused = mockFetch(() => Response.json({
    success: false,
    errors: [{ message: secret }],
  }, { status: 403 }));
  await assert.rejects(
    putWorkerSecret("AIG_ACCESS_KEY_AIR", { ...mockEnv, AIG_OPS_SECRET_VALUE: secret }, refused),
    (error: unknown) => error instanceof Error && error.message.includes("HTTP 403") && !error.message.includes(secret),
  );
  const invalid = mockFetch(() => ok([{ name: "AIG_DEPLOY_HEALTH_KEY", type: "plain_text" }]));
  await assert.rejects(listWorkerSecretNames(mockEnv, invalid), /Unexpected Cloudflare secret inventory/);
  const malformed = mockFetch(() => new Response("invalid json", { status: 200 }));
  await assert.rejects(listWorkerSecretNames(mockEnv, malformed), /invalid JSON/);
});

test("health failure after a secret update is reported without falsely claiming rollback", async () => {
  const fetcher = mockFetch((input, init) => {
    if (String(input) === endpoint && init?.method === "PUT") return ok({ name: "AIG_ACCESS_KEY_AIR", type: "secret_text" });
    if (String(input) === endpoint) return ok(names);
    return Response.json({ ready: false, nodes_total: 3, nodes_usable: 0 });
  });
  await assert.rejects(putWorkerSecret("AIG_ACCESS_KEY_AIR", mockEnv, fetcher), /previous value via a separately approved operation/);
});
