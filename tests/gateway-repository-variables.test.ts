import assert from "node:assert/strict";
import { test } from "node:test";
import { readGatewayRepositoryVariables } from "../scripts/read-gateway-repository-variables.ts";
import { validateGatewayOpsVariables } from "../scripts/gateway-ops-variables.ts";

const account = "0123456789abcdef0123456789abcdef";

test("only repository Variables are accepted without any ops Environment fallback", async () => {
  const requests: string[] = [];
  const request: typeof fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-read-token");
    return Response.json({
      total_count: 2,
      variables: [
        { name: "AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY", value: account },
        { name: "AIG_PUBLIC_URL", value: "https://gateway.example/" },
      ],
    });
  };
  const snapshot = await readGatewayRepositoryVariables("test-read-token", request);
  const validated = validateGatewayOpsVariables(snapshot);
  assert.equal(validated.AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY, account);
  assert.equal(validated.CLOUDFLARE_ACCOUNT_ID_SECONDARY, account);
  assert.equal(validated.AIG_PUBLIC_URL, "https://gateway.example");
  assert.deepEqual(requests, [
    "https://api.github.com/repos/fongap-labs/action-worker/actions/variables?per_page=100&page=1",
  ]);
});

test("Cloudflare token-shaped repository Variables are never exported", async () => {
  for (const name of ["CLOUDFLARE_API_TOKEN_SECONDARY", "AW_CLOUDFLARE_API_TOKEN_SECONDARY"]) {
    const request: typeof fetch = async () =>
      Response.json({ total_count: 2, variables: [
        { name: "AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY", value: account },
        { name, value: "do-not-print-this-value" },
      ] });
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
    () => readGatewayRepositoryVariables("read-token", async () => new Response("", { status: 403 })),
    /denied or unavailable/
  );
  await assert.rejects(
    () => readGatewayRepositoryVariables("read-token", async () => Response.json({ variables: [{}] })),
    /entry is invalid/
  );
  await assert.rejects(
    () => readGatewayRepositoryVariables("read-token", async () => Response.json({
      variables: [
        { name: "AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY", value: account },
        { name: "AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY", value: account },
      ],
    })),
    /duplicated names/
  );
});
