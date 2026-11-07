import { spawnSync } from "node:child_process";
import { isMain } from "./runtime-command.ts";

export type PreflightMode = "quick" | "full";
export type PreflightStep = { command: string; args: string[] };

export function preflightSteps(mode: PreflightMode): PreflightStep[] {
  if (mode === "quick") {
    return [
      { command: "npm", args: ["run", "typecheck"] },
      { command: "npm", args: ["run", "lint"] },
      {
        command: "node",
        args: [
          "--test",
          "tests/workflow-environments.test.ts",
          "tests/release-build-manifest.test.ts",
          "tests/release-build-attestation-isolation.test.ts",
        ],
      },
    ];
  }
  return [
    { command: "npm", args: ["run", "check"] },
    { command: "python3", args: ["tests/test-source-naming.py"] },
  ];
}

function runStep(step: PreflightStep): void {
  const command =
    process.platform === "win32" && step.command === "python3" ? "python" : step.command;
  console.log(`[preflight] ${command} ${step.args.join(" ")}`);
  const result = spawnSync(command, step.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const mode = process.argv[2] ?? "quick";
  if (mode === "--help" || mode === "-h") {
    console.log(
      "Usage: npm run preflight [-- quick|full]\n" +
        "quick: typecheck, lint and focused environment/release contracts\n" +
        "full:  all local typecheck/lint/tests and source naming tests\n" +
        "Neither mode replaces remote security, GitHub permission, runner isolation or merge checks."
    );
    return;
  }
  if (mode !== "quick" && mode !== "full") {
    throw new Error(`Unknown preflight mode: ${mode}. Use quick or full.`);
  }
  for (const step of preflightSteps(mode)) runStep(step);
  console.log("[preflight] Local checks passed; GitHub validate-merge remains authoritative.");
}

if (isMain(import.meta.url)) {
  main();
}
