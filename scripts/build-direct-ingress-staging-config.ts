import { writeFile } from "node:fs/promises";
import { CliError, handleError, isMain } from "./runtime-command.ts";

export type DirectIngressStagingInputs = {
  databaseName: string;
  databaseId: string;
  appId: string;
  installationId: string;
};

const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const databaseNamePattern = /^[a-z][a-z0-9_-]{2,62}$/;
const positiveIdPattern = /^[1-9][0-9]*$/;
export const directIngressStagingConfigPath = ".direct-ingress-staging.wrangler.json";

/**
 * An inert, separate Worker configuration. No public URL, preview URL or Cron
 * is enabled; non-production resource and App identifiers are required first.
 * Never accept a Secret value in this object.
 */
export function buildDirectIngressStagingConfig(input: DirectIngressStagingInputs) {
  if (
    !databaseNamePattern.test(input.databaseName) ||
    !databaseIdPattern.test(input.databaseId) ||
    !positiveIdPattern.test(input.appId) ||
    !positiveIdPattern.test(input.installationId)
  ) {
    throw new CliError("::error::Approved staging D1 and GitHub App identifiers are required.", 64);
  }
  return {
    name: "action-worker-direct-ingress-staging",
    main: "scripts/direct-event-ingress.ts",
    compatibility_date: "2026-11-09",
    workers_dev: false,
    preview_urls: false,
    routes: [],
    triggers: { crons: [] },
    d1_databases: [
      {
        binding: "AW_INGRESS_DB",
        database_name: input.databaseName,
        database_id: input.databaseId,
      },
    ],
    vars: {
      AW_CONTROL_REPOSITORY: "fongap-labs/action-worker",
      AW_GITHUB_APP_ID: input.appId,
      AW_GITHUB_APP_INSTALLATION_ID: input.installationId,
    },
  };
}

async function main(): Promise<void> {
  const config = buildDirectIngressStagingConfig({
    databaseName: process.env.AW_INGRESS_DATABASE_NAME ?? "",
    databaseId: process.env.AW_INGRESS_DATABASE_ID ?? "",
    appId: process.env.AW_GITHUB_APP_ID ?? "",
    installationId: process.env.AW_GITHUB_APP_INSTALLATION_ID ?? "",
  });
  await writeFile(directIngressStagingConfigPath, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Inert staging Wrangler config written. Public routes and Cron are disabled.");
}

if (isMain(import.meta.url)) main().catch(handleError);
