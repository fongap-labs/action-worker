import { appendLines, CliError, handleError, isMain, runText } from "./runtime-command.ts";
import { prepareStatusSigningKeys, signingSnapshotIsFresh } from "./status-signing-keys.ts";

export function reportSigningSecretAccessError(error: unknown, repository: string): never {
  if (
    error instanceof CliError &&
    /(?:HTTP|status)\s+403\b/i.test(error.message) &&
    !/rate limit exceeded|secondary rate limit|abuse detection/i.test(error.message)
  ) {
    throw new CliError(
      `::error::Cannot manage Actions Secret AW_STATUS_SIGNING_KEYS in ${repository} (HTTP 403). The protected admin-ops credential must have repository Secrets: Read and write permission; any GitHub App installation must also approve this grant. Keep AW_STATUS_TOKEN legacy verification until bootstrap succeeds.`,
      77
    );
  }
  throw error;
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const adminToken = process.env.GH_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !adminToken)
    throw new CliError(
      "Signing bootstrap requires the control repository and administrative credential.",
      77
    );
  const result = prepareStatusSigningKeys(
    process.env.AW_STATUS_SIGNING_KEYS ?? "",
    process.env.AW_STATUS_SIGNING_KEY_ID || "k1",
    undefined,
    process.env.AW_STATUS_TOKEN ?? ""
  );
  if (result.changed) {
    const dispatchToken = process.env.AW_DISPATCH_API_TOKEN ?? "";
    if (!dispatchToken)
      throw new CliError(
        "Signing bootstrap requires an App dispatch token to wake governance with the new keyring.",
        77
      );
    const readToken = process.env.AW_BOOTSTRAP_READ_TOKEN ?? "";
    const runId = process.env.GITHUB_RUN_ID ?? "";
    if (!readToken || !/^[1-9][0-9]*$/.test(runId))
      throw new CliError(
        "Signing bootstrap needs its read-only Actions credential and run ID.",
        77
      );
    const run = JSON.parse(
      await runText("gh", ["api", `repos/${repository}/actions/runs/${runId}`], {
        env: { ...process.env, GH_TOKEN: readToken },
        timeoutMs: 30_000,
      })
    );
    let metadata: unknown | null;
    try {
      metadata = JSON.parse(
        await runText("gh", ["api", `repos/${repository}/actions/secrets/AW_STATUS_SIGNING_KEYS`], {
          env: { ...process.env, GH_TOKEN: adminToken },
          timeoutMs: 30_000,
        })
      );
    } catch (error) {
      if (error instanceof Error && /HTTP 404\b/.test(error.message)) {
        metadata = null;
      } else {
        reportSigningSecretAccessError(error, repository);
      }
    }
    if (
      !signingSnapshotIsFresh(
        process.env.AW_STATUS_SIGNING_KEYS ?? "",
        metadata,
        String(run.created_at ?? "")
      )
    ) {
      console.log(
        "::warning::Signing secret snapshot is stale; preserving the newer keyring. A freshly queued settings run will reconcile it."
      );
      return;
    }
    // gh encrypts the secret using the repository public key. Neither the key nor retained legacy
    // verifier material is printed or passed on the command line.
    try {
      await runText("gh", ["secret", "set", "AW_STATUS_SIGNING_KEYS", "--repo", repository], {
        input: JSON.stringify(result.keys),
        env: { ...process.env, GH_TOKEN: adminToken },
        timeoutMs: 30_000,
      });
    } catch (error) {
      reportSigningSecretAccessError(error, repository);
    }
    // A newly queued run receives the newly saved repository secret; this run keeps its snapshot.
    await runText(
      "gh",
      ["api", "--method", "POST", `repos/${repository}/dispatches`, "-f", "event_type=run-intake"],
      {
        env: { ...process.env, GH_TOKEN: dispatchToken },
        timeoutMs: 30_000,
      }
    );
  }
  console.log(
    `Status signing keyring ${result.changed ? "initialized or rotated" : "already current"}: ${result.keys.active}.`
  );
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Status signing",
    "",
    `Active key ID: ${result.keys.active}. The signing key is independent from GitHub API access. Previous signing keys and legacy aw1 HMAC verifiers are retained.`,
  ]);
}

if (isMain(import.meta.url)) main().catch(handleError);
