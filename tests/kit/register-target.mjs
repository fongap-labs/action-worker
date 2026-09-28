// Preload (node --import): maps "#target/<path>" specifiers to files inside the
// repository under test, so pack suites can import target source without a
// relative path that would point back into this repository.
import { registerHooks } from "node:module";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = "#target/";
const root = process.env.CENTRAL_TEST_TARGET_ROOT ?? "";
if (!root || !isAbsolute(root)) {
  throw new Error(
    "CENTRAL_TEST_TARGET_ROOT must be an absolute path to the repository under test."
  );
}
const base = resolve(root);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(prefix)) {
      return nextResolve(specifier, context);
    }
    const file = resolve(join(base, specifier.slice(prefix.length)));
    if (file !== base && !file.startsWith(base + sep)) {
      throw new Error(`Target import escapes the target root: ${specifier}`);
    }
    return nextResolve(pathToFileURL(file).href, context);
  },
});
