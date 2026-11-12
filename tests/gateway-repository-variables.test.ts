import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { validateGatewayOpsVariables } from "../scripts/gateway-ops-variables.ts";
import {
  readGatewayRepositoryVariables,
  readGatewayVariablesWithApp,
} from "../scripts/gateway-repository-vars.ts";

const account = "0123456789abcdef0123456789abcdef";

test("only repository Variables are accepted without any ops Environment fallback", async () => {
  const requests: string[] = [];
  const request: typeof fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-read-token");
    return Response.json({
      total_count: 2,
      variables: [
        { name: "CLOUDFLARE_ACCOUNT_ID_REPOSITORY", value: account },
        { name: "AIG_PUBLIC_URL", value: "https://gateway.example/" },
      ],
    });
  };
  const snapshot = await readGatewayRepositoryVariables("test-read-token", request);
  const validated = validateGatewayOpsVariables(snapshot);
  assert.equal(validated.CLOUDFLARE_ACCOUNT_ID_REPOSITORY, account);
  assert.equal(validated.CLOUDFLARE_ACCOUNT_ID_SECONDARY, account);
  assert.equal(validated.AIG_PUBLIC_URL, "https://gateway.example");
  assert.deepEqual(requests, [
    "https://api.github.com/repos/fongap-labs/action-worker/actions/variables?per_page=30&page=1",
  ]);
});

test("Cloudflare token-shaped repository Variables are never exported", async () => {
  for (const name of ["CLOUDFLARE_API_TOKEN_SECONDARY", "CLOUDFLARE_API_TOKEN_REPOSITORY"]) {
    const request: typeof fetch = async () =>
      Response.json({
        total_count: 2,
        variables: [
          { name: "CLOUDFLARE_ACCOUNT_ID_REPOSITORY", value: account },
          { name, value: "do-not-print-this-value" },
        ],
      });
    await assert.rejects(
      () => readGatewayRepositoryVariables("test-read-token", request),
      /Cloudflare API Token must be a GitHub repository Secret/
    );
  }
});

test("repository Variable inventory is bounded, denied requests fail closed", async () => {
  await assert.rejects(
    () => readGatewayRepositoryVariables("", async () => Response.json({ variables: [] })),
    /requires a GitHub token/
  );
  await assert.rejects(
    () =>
      readGatewayRepositoryVariables("read-token", async () => new Response("", { status: 403 })),
    /denied or unavailable/
  );
  await assert.rejects(
    () =>
      readGatewayRepositoryVariables("read-token", async () => Response.json({ variables: [{}] })),
    /entry is invalid/
  );
  await assert.rejects(
    () =>
      readGatewayRepositoryVariables("read-token", async () =>
        Response.json({
          variables: [
            { name: "CLOUDFLARE_ACCOUNT_ID_REPOSITORY", value: account },
            { name: "CLOUDFLARE_ACCOUNT_ID_REPOSITORY", value: account },
          ],
        })
      ),
    /duplicated names/
  );
});

const { privateKey: testKey, publicKey: testPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const testAppKey = testKey.export({ format: "pem", type: "pkcs8" }).toString();
const scopedToken = "ghs_test_variable_reader_token_0123456789";

test("App Variables reader mints a signed, one-repository read-only token and revokes it", async () => {
  const called: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = String(url);
    called.push(path);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (path.endsWith("/installation") && init?.method === undefined) {
      assert.ok(authorization.startsWith("Bearer "));
      const jwt = authorization.slice(7);
      const [header, body, signature] = jwt.split(".");
      assert.ok(header && body && signature);
      assert.equal(JSON.parse(Buffer.from(body, "base64url").toString()).iss, "Iv1.test-app-id");
      assert.equal(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${body}`),
          testPublicKey,
          Buffer.from(signature, "base64url")
        ),
        true
      );
      return Response.json({ id: 178503233 });
    }
    if (path.endsWith("/access_tokens")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["action-worker"],
        permissions: { actions_variables: "read" },
      });
      return Response.json({
        token: scopedToken,
        permissions: { actions_variables: "read", metadata: "read" },
      });
    }
    if (path.includes("/actions/variables?")) {
      assert.equal(authorization, `Bearer ${scopedToken}`);
      return Response.json({
        variables: [{ name: "CLOUDFLARE_ACCOUNT_ID_REPOSITORY", value: account }],
      });
    }
    if (path.endsWith("/installation/token")) {
      assert.equal(init?.method, "DELETE");
      assert.equal(authorization, `Bearer ${scopedToken}`);
      return new Response(null, { status: 204 });
    }
    throw Error("unexpected endpoint");
  };
  const values = await readGatewayVariablesWithApp(
    "Iv1.test-app-id",
    testAppKey,
    request,
    1_790_000_000
  );
  assert.equal(values.CLOUDFLARE_ACCOUNT_ID_REPOSITORY, account);
  assert.deepEqual(called, [
    "https://api.github.com/repos/fongap-labs/action-worker/installation",
    "https://api.github.com/app/installations/178503233/access_tokens",
    "https://api.github.com/repos/fongap-labs/action-worker/actions/variables?per_page=30&page=1",
    "https://api.github.com/installation/token",
  ]);
});

test("missing Variables App permission fails closed at token mint without exposing App responses", async () => {
  const called: string[] = [];
  const request: typeof fetch = async (url) => {
    called.push(String(url));
    if (String(url).endsWith("/installation")) return Response.json({ id: 178503233 });
    return new Response("sensitive-token-material", { status: 422 });
  };
  await assert.rejects(
    readGatewayVariablesWithApp("Iv1.test-app-id", testAppKey, request),
    /lacks repository Actions Variables: read/
  );
  assert.equal(called.length, 2);
});

test("inventory rejection and unexpected token permissions both revoke the token", async () => {
  for (const scenario of ["denied-inventory", "excess-scope"]) {
    let revoked = false;
    const request: typeof fetch = async (url) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/installation")) return Response.json({ id: 178503233 });
      if (endpoint.endsWith("/access_tokens")) {
        return Response.json({
          token: scopedToken,
          permissions:
            scenario === "excess-scope"
              ? { actions_variables: "read", contents: "write" }
              : { actions_variables: "read" },
        });
      }
      if (endpoint.endsWith("/installation/token")) {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      if (endpoint.includes("/actions/variables?")) return new Response(null, { status: 403 });
      throw Error("unexpected endpoint");
    };
    await assert.rejects(
      readGatewayVariablesWithApp("Iv1.test-app-id", testAppKey, request),
      scenario === "excess-scope" ? /unexpected repository permissions/ : /denied or unavailable/
    );
    assert.equal(revoked, true);
  }
});

test("legacy variables permission slug is rejected even if token issuance succeeds", async () => {
  let isRevoked = false;
  const request: typeof fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/installation")) return Response.json({ id: 178503233 });
    if (endpoint.endsWith("/access_tokens")) {
      return Response.json({ token: scopedToken, permissions: { variables: "read" } });
    }
    if (endpoint.endsWith("/installation/token")) {
      isRevoked = true;
      return new Response(null, { status: 204 });
    }
    throw Error("unexpected endpoint");
  };
  await assert.rejects(
    readGatewayVariablesWithApp("Iv1.test-app-id", testAppKey, request),
    /unexpected repository permissions/
  );
  assert.equal(isRevoked, true);
});

test("failed revocation prevents exporting deployment variables", async () => {
  const request: typeof fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/installation")) return Response.json({ id: 178503233 });
    if (endpoint.endsWith("/access_tokens"))
      return Response.json({ token: scopedToken, permissions: { actions_variables: "read" } });
    if (endpoint.includes("/actions/variables?"))
      return Response.json({
        variables: [{ name: "AIG_PUBLIC_URL", value: "https://gateway.example" }],
      });
    return new Response(null, { status: 403 });
  };
  await assert.rejects(
    readGatewayVariablesWithApp("Iv1.test-app-id", testAppKey, request),
    /could not be revoked/
  );
});

test("Gateway deploy workflow uses a non-environment repository snapshot and no unsupported App inputs", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<
      string,
      {
        environment?: unknown;
        steps: Array<{ name?: string; uses?: string; env?: Record<string, string> }>;
      }
    >;
  };
  const job = workflow.jobs.gateway_variables;
  assert.ok(job);
  assert.equal(job.environment, undefined);
  const reader = job.steps.find(
    (step) => step.name === "Validate non-sensitive AI Gateway repository Variables"
  );
  assert.ok(reader);
  assert.equal(reader.env?.AW_APP_CLIENT_ID, "${{ vars.AW_APP_CLIENT_ID }}");
  assert.equal(reader.env?.AW_APP_PRIVATE_KEY, "${{ secrets.AW_APP_PRIVATE_KEY }}");
  assert.equal(reader.env?.GITHUB_TOKEN, undefined);
  assert.equal(
    job.steps.some((step) => step.name?.includes("Mint repository-only Variables")),
    false
  );
  assert.equal(JSON.stringify(job).includes("permission-variables"), false);
});
