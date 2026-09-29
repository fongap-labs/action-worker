import { parseRunnerPolicy, type RunnerPolicy, resolveRunnerProfile } from "./runner-policy.ts";
import { CliError, handleError, isMain, readJson } from "./runtime-command.ts";

// Value for the AW_DISPATCH_RUNS_ON repository variable read by the approved PR dispatcher
// (templates/pr-dispatcher). Business repositories never name runners; this script is the only
// place a profile turns into labels.
export function dispatcherRunsOn(policy: RunnerPolicy, requestedProfile: string): string {
  const { profile } = resolveRunnerProfile(policy, requestedProfile);
  if (profile.trust_domain !== "control") {
    throw new CliError(
      "The PR dispatcher only runs on control-domain runner profiles; it never executes PR code.",
      65
    );
  }
  const [only] = profile.labels;
  if (profile.backend === "github-hosted" && profile.labels.length === 1 && only) {
    return JSON.stringify(only);
  }
  return JSON.stringify(profile.labels);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const policyPath = args.length === 2 ? (args[0] ?? "") : "policies/runner.json";
  const profile = args.length === 2 ? (args[1] ?? "") : (args[0] ?? "");
  if (args.length < 1 || args.length > 2 || !profile) {
    throw new CliError("Usage: resolve-dispatcher-runs-on.ts [policy-path] <runner-profile>", 64);
  }
  console.log(dispatcherRunsOn(parseRunnerPolicy(await readJson(policyPath)), profile));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
