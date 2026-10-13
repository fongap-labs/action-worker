import { CliError } from "./runtime-command.ts";

// A deploy policy key names a repository ("owner/name") or one product of a repository
// ("owner/name/product"). Keys never use wildcards, so one entry covers exactly one product.
const repositorySegment = "[A-Za-z0-9_.-]+";
const productSegment = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const keyPattern = new RegExp(`^${repositorySegment}/${repositorySegment}(?:/${productSegment})?$`);

export function isDeployPolicyKey(key: string): boolean {
  return keyPattern.test(key);
}

// The root layout (one product in .github/) keeps the repository key, so existing entries stay valid.
export function productPolicyKey(repository: string, product: string): string {
  return product === "" ? repository : `${repository}/${product}`;
}

// An environment name belongs to one key across the whole policy, so one GitHub environment never
// serves two products.
export function assertUniqueEnvironments(
  entries: Iterable<[key: string, environments: readonly string[]]>,
  label: string
): void {
  const owners = new Map<string, string>();
  for (const [key, environments] of entries) {
    for (const environment of environments) {
      const owner = owners.get(environment);
      if (owner !== undefined && owner !== key) {
        throw new CliError(
          `${label} lists environment ${environment} under both ${owner} and ${key}. An environment belongs to one key.`,
          65
        );
      }
      owners.set(environment, key);
    }
  }
}
