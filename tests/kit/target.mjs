// Resolves the repository under test. Pack suites never live next to the code
// they verify; the runner points them at the checked-out target via
// CENTRAL_TEST_TARGET_ROOT.
import { isAbsolute, join, resolve } from "node:path";

function requireTargetRoot() {
  const value = process.env.CENTRAL_TEST_TARGET_ROOT ?? "";
  if (!value || !isAbsolute(value)) {
    throw new Error(
      "CENTRAL_TEST_TARGET_ROOT must be an absolute path to the repository under test."
    );
  }
  return resolve(value);
}

export const targetRoot = requireTargetRoot();

export function targetPath(...segments) {
  return join(targetRoot, ...segments);
}
