// Builds a minimal, safe environment for the test subprocess spawned by
// run-pack.mjs. Only process.env entries that appear (case-insensitively, to
// survive Windows mixed-case var names) in the base set or in the pack
// manifest's "env" array are forwarded. This prevents a mutable local
// environment — or a GitHub Actions runner — from leaking CI tokens
// (AW_ADMIN_TOKEN, AW_CONTROL_TOKEN, AW_DISPATCH_TOKEN), local secrets
// (AIG_TOKEN_ENCRYPTION_KEY, AIG_ACCESS_KEY_*), or any other unaccounted var
// into test code that runs against an untrusted target-checkout.
//
// Packs that genuinely need an extra variable must declare it explicitly in
// pack.json ("env": ["VAR_NAME"]); the name is validated against
// ^[A-Z][A-Z0-9_]*$ and unknown/invalid names cause a hard error.

/** @type {Set<string>} Base variable names accepted from the host environment. */
const BASE_VARS = new Set([
  // --- Cross-platform essentials ---
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "CI",
  // --- Windows essentials (node/python/git cannot start without these) ---
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "OS",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
]);

const _NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** @param {string} name */
function validateName(name) {
  if (!_NAME_RE.test(name)) {
    throw new Error(
      `pack env: declared name "${name}" is not a valid variable name (^[A-Z][A-Z0-9_]*$)`
    );
  }
}

/**
 * @param {{ env?: string[] }} manifest  Parsed pack.json.
 * @param {string} target    Absolute path to the repository under test.
 * @returns {NodeJS.ProcessEnv}
 */
export function buildPackEnv(manifest, target) {
  /** @type {Set<string>} */
  const allowed = new Set(BASE_VARS);
  const declared = Array.isArray(manifest.env) ? manifest.env : [];
  for (const name of declared) {
    validateName(name);
    allowed.add(name);
  }

  const env = /** @type {NodeJS.ProcessEnv} */ ({ CENTRAL_TEST_TARGET_ROOT: target });
  for (const key of Object.keys(process.env)) {
    if (allowed.has(key.toUpperCase())) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/** @returns {readonly string[]} Names a pack is allowed to declare. */
export function baseEnvNames() {
  return [...BASE_VARS].sort();
}
