import { CliError, handleError, isMain } from "./runtime-command.ts";

export function requiredCiJobsPassed(
  linux: string,
  security: string,
  windows: string,
  hasWindows: string
): boolean {
  return (
    linux === "success" &&
    security === "success" &&
    (hasWindows === "true"
      ? windows === "success"
      : hasWindows === "false" && windows === "skipped")
  );
}

function main(): void {
  const [linux = "", security = "", windows = "", hasWindows = ""] = process.argv.slice(2);
  if (process.argv.length !== 6) {
    throw new CliError(
      "Usage: central-ci-required-jobs.ts <linux> <security> <windows> <has-windows>",
      64
    );
  }
  if (!requiredCiJobsPassed(linux, security, windows, hasWindows)) {
    throw new CliError("::error::Required central CI jobs are missing or not successful.", 75);
  }
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    handleError(error);
  }
}
