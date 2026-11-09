import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDispatchPayload,
  parseAgentAuthorization,
  resolveTrustedSourceSha,
  validateAgentRequest,
} from "../scripts/agent-task-ingress.ts";

const actor = { login: "fongap", id: 26006683, type: "User" };
const authorization = {
  schema_version: 1,
  enabled: true,
  repository_owner: "fongap-labs",
  operation: "task",
  authorized_actors: [{ login: "fongap", id: 26006683 }],
};
const environment = {
  eventName: "workflow_dispatch",
  repository: "fongap-labs/action-worker",
  ref: "refs/heads/main",
  actor: "fongap",
  actorId: "26006683",
  triggeringActor: "fongap",
  runId: "1234567",
  attempt: "1",
};
const policies = {
  "fongap-labs/action-worker": ["pr", "task"],
  "fongap-labs/ai-gateway": ["pr", "task"],
  "fongap-labs/dsh-plugin": ["pr", "release-source"],
};
const event = {
  repository: { full_name: "fongap-labs/action-worker" },
  sender: actor,
  inputs: { repository: "fongap-labs/ai-gateway", project: "repair" },
};
const sha = "a".repeat(40);

test("private Agent ingress accepts a known GitHub actor and an explicitly task-enabled repository", () => {
  assert.deepEqual(validateAgentRequest(event, environment, authorization, policies), {
    repository: "fongap-labs/ai-gateway",
    repository_name: "ai-gateway",
    project: "repair",
    request_id: "agent-1234567-1",
  });
});

test("shared MCP users cannot impersonate the fongap owner through the agent name or request body", () => {
  for (const change of [
    { sender: { login: "stranger", id: 123, type: "User" } },
    { sender: { login: "fongap", id: 123, type: "User" } },
    { sender: { login: "fongap", id: 26006683, type: "Bot" } },
    { repository: { full_name: "fongap-labs/mcp-hub" } },
  ]) {
    assert.throws(() =>
      validateAgentRequest({ ...event, ...change }, environment, authorization, policies)
    );
  }
  assert.throws(() =>
    validateAgentRequest(event, { ...environment, actor: "other" }, authorization, policies)
  );
  assert.throws(() =>
    validateAgentRequest(event, { ...environment, actorId: "123" }, authorization, policies)
  );
  assert.throws(() =>
    validateAgentRequest(
      event,
      { ...environment, triggeringActor: "other" },
      authorization,
      policies
    )
  );
  const { sender: _sender, ...senderOmitted } = event;
  assert.equal(
    validateAgentRequest(senderOmitted, environment, authorization, policies).project,
    "repair"
  );
  assert.throws(() =>
    validateAgentRequest(
      event,
      { ...environment, ref: "refs/heads/feature" },
      authorization,
      policies
    )
  );
  assert.throws(() =>
    validateAgentRequest(
      event,
      { ...environment, eventName: "repository_dispatch" },
      authorization,
      policies
    )
  );
});

test("unapproved repositories and dynamic commands are rejected", () => {
  const project = (repository: string, extra = {}) => ({
    ...event,
    inputs: { repository, project: "repair", ...extra },
  });
  assert.throws(() =>
    validateAgentRequest(project("fongap-labs/dsh-plugin"), environment, authorization, policies)
  );
  assert.throws(() =>
    validateAgentRequest(project("untrusted/outside"), environment, authorization, policies)
  );
  assert.throws(() =>
    validateAgentRequest(
      project("fongap-labs/ai-gateway", { command: "rm -rf /" }),
      environment,
      authorization,
      policies
    )
  );
  assert.throws(() =>
    validateAgentRequest(
      { ...event, inputs: { ...event.inputs, project: "../escape" } },
      environment,
      authorization,
      policies
    )
  );
});

test("policy disabled and unauthorized callers always fail closed", () => {
  assert.throws(() => parseAgentAuthorization({ ...authorization, enabled: false }));
  assert.throws(() =>
    validateAgentRequest(event, environment, { ...authorization, authorized_actors: [] }, policies)
  );
});

test("task target SHA must be obtained from an active main branch, never from caller input", async () => {
  const received: string[] = [];
  const fakeFetch = async (_token: string, path: string) => {
    received.push(path);
    return path.endsWith("/commits/main") ? { sha } : { default_branch: "main" };
  };
  assert.equal(
    await resolveTrustedSourceSha("fongap-labs/ai-gateway", "read-only", fakeFetch),
    sha
  );
  assert.deepEqual(received, [
    "repos/fongap-labs/ai-gateway",
    "repos/fongap-labs/ai-gateway/commits/main",
  ]);
  await assert.rejects(() =>
    resolveTrustedSourceSha("fongap-labs/ai-gateway", "read-only", async () => ({
      default_branch: "release",
    }))
  );
  assert.throws(() =>
    agentDispatchPayload(
      {
        repository: "fongap-labs/ai-gateway",
        repository_name: "ai-gateway",
        project: "repair",
        request_id: "agent-1234567-1",
      },
      "untrusted"
    )
  );
});

test("dispatch payload contains only existing trusted task contract fields", () => {
  assert.deepEqual(
    agentDispatchPayload(
      {
        repository: "fongap-labs/ai-gateway",
        repository_name: "ai-gateway",
        project: "repair",
        request_id: "agent-1234567-1",
      },
      sha
    ),
    {
      event_type: "run-task",
      client_payload: {
        schema_version: "1",
        repository: "fongap-labs/ai-gateway",
        project: "repair",
        request_id: "agent-1234567-1",
        bootstrap_ref: sha,
        agent_domain: "coding",
        operation: "task",
      },
    }
  );
});
