/**
 * Optional GitHub App webhook endpoint. This only wakes the existing central Intake reconciler:
 * webhook payload fields never become execution or publication authority.
 *
 * The database schema is in docs/direct-event-ingress.sql. No production route is enabled here.
 */
export interface IngressStatement {
  bind(...values: (string | number | null)[]): IngressStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface IngressDatabase {
  prepare(sql: string): IngressStatement;
}

export interface IngressEnvironment {
  AW_INGRESS_DB: IngressDatabase;
  AW_GITHUB_WEBHOOK_SECRET: string;
  AW_GITHUB_APP_ID: string;
  AW_GITHUB_APP_INSTALLATION_ID: string;
  AW_GITHUB_APP_PRIVATE_KEY: string;
  AW_CONTROL_REPOSITORY: string;
}

type PendingDelivery = {
  delivery_id: string;
  installation_id: number;
};

type GithubEvent = {
  installation?: { id?: unknown };
  repository?: {
    full_name?: unknown;
    default_branch?: unknown;
    owner?: { login?: unknown };
  };
  ref?: unknown;
  before?: unknown;
  after?: unknown;
  deleted?: unknown;
  action?: unknown;
  number?: unknown;
  pull_request?: {
    number?: unknown;
    base?: { repo?: { full_name?: unknown } };
  };
};

const maxBodyBytes = 8 * 1024 * 1024;
const deliveryPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const leaseMs = 60_000;

/** Shared production SQL statements used by D1 and the SQLite contract suite. */
export const webhookDeliverySql = {
  reserve:
    "INSERT OR IGNORE INTO webhook_deliveries (delivery_id, body_digest, installation_id, event_name, source_repository, created_ms, lease_until_ms) VALUES (?, ?, ?, ?, ?, ?, 0)",
  findId: "SELECT delivery_id, body_digest FROM webhook_deliveries WHERE delivery_id = ?",
  findDigest: "SELECT delivery_id, body_digest FROM webhook_deliveries WHERE body_digest = ?",
  claim:
    "UPDATE webhook_deliveries SET lease_until_ms = ? WHERE delivery_id = ? AND delivered_ms IS NULL AND lease_until_ms <= ? RETURNING delivery_id",
  complete:
    "UPDATE webhook_deliveries SET delivered_ms = ?, lease_until_ms = 0 WHERE delivery_id = ?",
  pending:
    "SELECT delivery_id, installation_id FROM webhook_deliveries WHERE delivered_ms IS NULL AND lease_until_ms <= ? ORDER BY lease_until_ms ASC, created_ms ASC LIMIT 25",
} as const;

function configuration(env: IngressEnvironment): {
  owner: string;
  repository: string;
  installationId: number;
} {
  const repository = env.AW_CONTROL_REPOSITORY;
  const installationId = Number(env.AW_GITHUB_APP_INSTALLATION_ID);
  if (
    !repositoryPattern.test(repository ?? "") ||
    !/^[1-9]\d*$/.test(env.AW_GITHUB_APP_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.AW_GITHUB_APP_INSTALLATION_ID ?? "") ||
    !Number.isSafeInteger(installationId) ||
    !env.AW_GITHUB_WEBHOOK_SECRET ||
    !env.AW_GITHUB_APP_PRIVATE_KEY?.startsWith("-----BEGIN ") ||
    !env.AW_GITHUB_APP_PRIVATE_KEY?.includes("-----END ") ||
    !env.AW_INGRESS_DB
  ) {
    throw new Error("Direct ingress configuration is incomplete.");
  }
  const [owner = ""] = repository.split("/");
  return { owner, repository, installationId };
}

function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function verifyGithubSignature(
  body: Uint8Array,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const safeBody = new Uint8Array(new ArrayBuffer(body.byteLength));
  safeBody.set(body);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, safeBody));
  const supplied = bytesFromHex(signature.slice(7));
  let difference = 0;
  for (let i = 0; i < digest.length; i += 1) difference |= digest[i]! ^ supplied[i]!;
  return difference === 0;
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) {
      await reader.cancel();
      throw new Error("Webhook payload exceeds the size limit.");
    }
    parts.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

function isRelevantEvent(eventName: string, body: GithubEvent): boolean {
  // GitHub's HMAC covers the JSON body but NOT X-GitHub-Event. An authentic
  // unrelated event must not be reclassified by changing its unsigned header.
  if (eventName === "push") {
    return (
      typeof body.repository?.default_branch === "string" &&
      body.ref === "refs/heads/" + body.repository.default_branch &&
      typeof body.before === "string" &&
      /^[0-9a-f]{40}$/i.test(body.before) &&
      typeof body.after === "string" &&
      /^[0-9a-f]{40}$/i.test(body.after) &&
      body.deleted !== true
    );
  }
  if (eventName === "pull_request") {
    return (
      ["opened", "reopened", "synchronize", "ready_for_review"].includes(String(body.action)) &&
      typeof body.number === "number" &&
      Number.isSafeInteger(body.number) &&
      body.number > 0 &&
      body.pull_request?.number === body.number &&
      typeof body.pull_request.base?.repo?.full_name === "string" &&
      typeof body.repository?.full_name === "string" &&
      body.pull_request.base.repo.full_name.toLowerCase() ===
        body.repository.full_name.toLowerCase()
    );
  }
  return false;
}

function encodeUrlBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function appJwt(env: IngressEnvironment): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeUrlBase64(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  );
  const payload = encodeUrlBase64(
    new TextEncoder().encode(
      JSON.stringify({ iat: now - 60, exp: now + 480, iss: env.AW_GITHUB_APP_ID })
    )
  );
  const der = env.AW_GITHUB_APP_PRIVATE_KEY.split(/\r?\n/)
    .filter((line) => /^[A-Za-z0-9+/=]+$/.test(line))
    .join("");
  const raw = Uint8Array.from(atob(der), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const input = header + "." + payload;
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input))
  );
  return input + "." + encodeUrlBase64(signature);
}

/** Installation token is limited to the control repository and dispatch permission. */
export async function dispatchIntake(
  env: IngressEnvironment,
  installationId: number,
  apiFetch: typeof fetch = fetch
): Promise<void> {
  const { repository, installationId: configuredInstallationId } = configuration(env);
  // The inbox must not outlive or override the currently approved App installation.
  if (installationId !== configuredInstallationId) {
    throw new Error("Direct ingress installation changed; refusing stale delivery.");
  }
  const repositoryName = repository.split("/")[1]!;
  const tokenResponse = await apiFetch(
    "https://api.github.com/app/installations/" + installationId + "/access_tokens",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (await appJwt(env)),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repositories: [repositoryName], permissions: { contents: "write" } }),
    }
  );
  if (!tokenResponse.ok) throw new Error("GitHub App installation token request failed.");
  const tokenBody: unknown = await tokenResponse.json();
  const token =
    typeof tokenBody === "object" && tokenBody !== null && "token" in tokenBody
      ? (tokenBody as { token?: unknown }).token
      : undefined;
  if (typeof token !== "string" || !token)
    throw new Error("GitHub App installation token is missing.");
  const response = await apiFetch("https://api.github.com/repos/" + repository + "/dispatches", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "run-intake", client_payload: {} }),
  });
  if (response.status !== 204) throw new Error("Central Intake dispatch was not acknowledged.");
}

class DeliveryIdentityConflict extends Error {}

/** GitHub signs the body, not delivery/event headers; dedupe on body bytes as well as ID. */
async function signedBodyDigest(body: Uint8Array): Promise<string> {
  const safe = new Uint8Array(new ArrayBuffer(body.byteLength));
  safe.set(body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", safe));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reserveDelivery(
  env: IngressEnvironment,
  deliveryId: string,
  installationId: number,
  eventName: string,
  repository: string,
  digest: string
): Promise<PendingDelivery> {
  // UNIQUE body_digest prevents a signed body from being replayed under a forged delivery ID.
  await env.AW_INGRESS_DB.prepare(webhookDeliverySql.reserve)
    .bind(deliveryId, digest, installationId, eventName, repository, Date.now())
    .run();
  const byId = await env.AW_INGRESS_DB.prepare(webhookDeliverySql.findId)
    .bind(deliveryId)
    .first<{ delivery_id: string; body_digest: string }>();
  if (byId && byId.body_digest !== digest) {
    throw new DeliveryIdentityConflict("GitHub delivery ID was reused with different signed body.");
  }
  const row =
    byId ??
    (await env.AW_INGRESS_DB.prepare(webhookDeliverySql.findDigest)
      .bind(digest)
      .first<{ delivery_id: string; body_digest: string }>());
  if (!row || row.body_digest !== digest) {
    throw new Error("Direct ingress durable delivery reservation was not readable.");
  }
  return { delivery_id: row.delivery_id, installation_id: installationId };
}

async function attemptPending(
  env: IngressEnvironment,
  delivery: PendingDelivery,
  apiFetch: typeof fetch
): Promise<boolean> {
  const claimed = await env.AW_INGRESS_DB.prepare(webhookDeliverySql.claim)
    .bind(Date.now() + leaseMs, delivery.delivery_id, Date.now())
    .first<{ delivery_id: string }>();
  if (!claimed) return false;
  await dispatchIntake(env, delivery.installation_id, apiFetch);
  await env.AW_INGRESS_DB.prepare(webhookDeliverySql.complete)
    .bind(Date.now(), delivery.delivery_id)
    .run();
  return true;
}

/** An authenticated delivery only wakes Intake. Existing policy and status checks remain authoritative. */
export async function handleDirectWebhook(
  request: Request,
  env: IngressEnvironment,
  apiFetch: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let control: ReturnType<typeof configuration>;
  try {
    control = configuration(env);
  } catch {
    return new Response("Ingress is not configured", { status: 503 });
  }
  let body: Uint8Array;
  try {
    body = await boundedBody(request);
  } catch {
    return new Response("Invalid payload size", { status: 413 });
  }
  if (
    !(await verifyGithubSignature(
      body,
      request.headers.get("x-hub-signature-256"),
      env.AW_GITHUB_WEBHOOK_SECRET
    ))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const eventName = request.headers.get("x-github-event") ?? "";
  if (!deliveryPattern.test(deliveryId))
    return new Response("Invalid delivery identity", { status: 400 });
  let payload: GithubEvent;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as GithubEvent;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch {
    return new Response("Invalid event payload", { status: 400 });
  }
  const repository = payload.repository?.full_name;
  const owner = payload.repository?.owner?.login;
  if (
    payload.installation?.id !== control.installationId ||
    typeof repository !== "string" ||
    !repositoryPattern.test(repository) ||
    typeof owner !== "string" ||
    owner.toLowerCase() !== control.owner.toLowerCase() ||
    !repository.toLowerCase().startsWith(control.owner.toLowerCase() + "/")
  ) {
    return new Response("Event source is not authorized", { status: 403 });
  }
  if (
    repository.toLowerCase() === control.repository.toLowerCase() ||
    !isRelevantEvent(eventName, payload)
  ) {
    return new Response("Ignored", { status: 200 });
  }
  try {
    const delivery = await reserveDelivery(
      env,
      deliveryId,
      control.installationId,
      eventName,
      repository,
      await signedBodyDigest(body)
    );
    const dispatched = await attemptPending(env, delivery, apiFetch);
    return new Response(dispatched ? "Reconciliation requested" : "Already received", {
      status: 202,
    });
  } catch (error) {
    if (error instanceof DeliveryIdentityConflict) {
      return new Response("Conflicting delivery identity", { status: 409 });
    }
    // The durable pending record remains for scheduled replay after a transient API failure.
    return new Response("Reconciliation queued for retry", { status: 503 });
  }
}

/** Cron reconciliation is mandatory: a failed or ambiguous dispatch is never silently discarded. */
export async function retryPendingDeliveries(
  env: IngressEnvironment,
  apiFetch: typeof fetch = fetch
): Promise<number> {
  configuration(env);
  const pending = await env.AW_INGRESS_DB.prepare(webhookDeliverySql.pending)
    .bind(Date.now())
    .all<PendingDelivery>();
  let completed = 0;
  for (const delivery of pending.results) {
    try {
      if (await attemptPending(env, delivery, apiFetch)) completed += 1;
    } catch {
      // Keep the durable record and retry after the lease. Never expose credentials or payloads.
    }
  }
  return completed;
}

export default {
  fetch(request: Request, env: IngressEnvironment): Promise<Response> {
    return handleDirectWebhook(request, env);
  },
  async scheduled(_event: unknown, env: IngressEnvironment): Promise<void> {
    await retryPendingDeliveries(env);
  },
};
