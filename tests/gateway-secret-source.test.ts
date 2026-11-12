import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  cloudflareRepositorySecretProof,
  verifyGatewayCloudflareRepositorySecret,
} from "../scripts/gateway-secret-source.ts";

const nonce = "a".repeat(64);

test("repository Cloudflare Secret proof is one-time, deterministic, and non-reversible", () => {
  const proof = cloudflareRepositorySecretProof("test-cloudflare-token", nonce);
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.notEqual(proof, "test-cloudflare-token");
  assert.equal(proof, cloudflareRepositorySecretProof("test-cloudflare-token", nonce));
  assert.notEqual(proof, cloudflareRepositorySecretProof("test-cloudflare-token", "b".repeat(64)));
  assert.doesNotThrow(() =>
    verifyGatewayCloudflareRepositorySecret("test-cloudflare-token", nonce, proof)
  );
});

test("missing or shadowed Cloudflare Secret fails before deployment", () => {
  const proof = cloudflareRepositorySecretProof("repository-token", nonce);
  assert.throws(() => cloudflareRepositorySecretProof("", nonce), /unavailable/);
  assert.throws(() => cloudflareRepositorySecretProof("repository-token", "bad"), /invalid/);
  assert.throws(
    () => verifyGatewayCloudflareRepositorySecret("environment-token", nonce, proof),
    /differs from the Action Worker repository scope/
  );
  assert.throws(
    () => verifyGatewayCloudflareRepositorySecret("repository-token", nonce, ""),
    /unavailable or invalid/
  );
});

test("AI Gateway deployment checks Cloudflare Secret before staging credentials", () => {
  type Step = { name?: string; id?: string; env?: Record<string, string>; run?: string };
  type Job = {
    environment?: unknown;
    outputs?: Record<string, string>;
    steps?: Step[];
  };
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, Job>;
  };
  const repositoryJob = workflow.jobs.gateway_variables;
  assert.equal(repositoryJob?.environment, undefined);
  const prove = repositoryJob?.steps?.find(
    (step) => step.name === "Prove Action Worker Cloudflare Secret source"
  );
  assert.equal(
    prove?.env?.CLOUDFLARE_API_TOKEN_SECONDARY,
    "${{ secrets.CLOUDFLARE_API_TOKEN_SECONDARY }}"
  );
  assert.equal(prove?.run, "node scripts/gateway-secret-source.ts prove");
  assert.equal(
    repositoryJob?.outputs?.cloudflare_proof,
    "${{ steps.cloudflare_secret.outputs.proof }}"
  );
  const deploy = workflow.jobs.deploy;
  const verifyIndex =
    deploy?.steps?.findIndex(
      (step) => step.name === "Reject an Environment Cloudflare Secret override"
    ) ?? -1;
  const stageIndex =
    deploy?.steps?.findIndex((step) => step.name === "Stage authorized deployment Secrets") ?? -1;
  assert.ok(verifyIndex >= 0 && stageIndex > verifyIndex);
  const verify = deploy?.steps?.[verifyIndex];
  assert.equal(
    verify?.env?.CLOUDFLARE_API_TOKEN_SECONDARY,
    "${{ secrets.CLOUDFLARE_API_TOKEN_SECONDARY }}"
  );
  assert.equal(
    verify?.env?.AW_CLOUDFLARE_REPOSITORY_PROOF,
    "${{ needs.gateway_variables.outputs.cloudflare_proof }}"
  );
  assert.equal(verify?.run, "node control/scripts/gateway-secret-source.ts verify");
});
