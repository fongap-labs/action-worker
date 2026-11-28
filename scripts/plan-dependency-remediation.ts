import { type DependencyPolicy, evaluateDeclaration } from "./dependency-version-policy.ts";

export type LocatedDeclaration = {
  path: string;
  blob_sha: string;
  key: string;
  version: string;
};
type Branch = "main" | "dev";
type LockStrategy = "npm-lock" | "pnpm-lock" | "declaration-only" | "manual-review";
type PlanItem = LocatedDeclaration & {
  target_version: string;
  strategy: LockStrategy;
  lock_path: string | null;
};
export type RemediationPlan = {
  repository: string;
  branch: Branch;
  base_sha: string;
  changes: PlanItem[];
  automatic_writes: false;
};

const shaPattern = /^[0-9a-f]{40}$/;
const pathPattern = /^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/;

function isSafePath(path: string): boolean {
  return (
    path.length <= 512 &&
    pathPattern.test(path) &&
    !path.split("/").some((part) => part === "." || part === ".." || part === ".git")
  );
}

function npmLockStrategy(
  path: string,
  locks: readonly string[]
): Pick<PlanItem, "strategy" | "lock_path"> {
  const parents = path.split("/").slice(0, -1);
  for (let depth = parents.length; depth >= 0; depth--) {
    const directory = parents.slice(0, depth).join("/");
    const prefix = directory ? directory + "/" : "";
    const candidates = locks.filter(
      (lock) =>
        lock === prefix + "package-lock.json" ||
        lock === prefix + "npm-shrinkwrap.json" ||
        lock === prefix + "pnpm-lock.yaml" ||
        lock === prefix + "yarn.lock"
    );
    if (candidates.length === 0) continue;
    const lock = candidates[0];
    if (candidates.length === 1 && lock && isSafePath(lock)) {
      if (lock.endsWith("package-lock.json")) {
        return { strategy: "npm-lock", lock_path: lock };
      }
      if (lock.endsWith("pnpm-lock.yaml")) {
        return { strategy: "pnpm-lock", lock_path: lock };
      }
    }
    break;
  }
  return { strategy: "manual-review", lock_path: null };
}

export function planDependencyRemediation(
  policy: DependencyPolicy,
  repository: string,
  branch: Branch,
  baseSha: string,
  declarations: readonly LocatedDeclaration[],
  locks: readonly string[],
  today: string
): RemediationPlan {
  if (!shaPattern.test(baseSha)) throw new Error("Invalid remediation base SHA.");
  const changes: PlanItem[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const status = evaluateDeclaration(
      policy,
      repository,
      branch,
      declaration.key,
      declaration.version,
      today
    );
    if (status !== "different" && status !== "range-review") continue;
    const target = policy.catalog.get(declaration.key)?.version;
    if (!target) continue;
    const identity = JSON.stringify(declaration);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const file = declaration.path.split("/").at(-1);
    let decision: Pick<PlanItem, "strategy" | "lock_path"> = {
      strategy: "manual-review",
      lock_path: null,
    };
    if (
      !declaration.version.startsWith("npm:") &&
      isSafePath(declaration.path) &&
      shaPattern.test(declaration.blob_sha)
    ) {
      const isExactTarget = /^\d+\.\d+\.\d+$/.test(target);
      if (
        isExactTarget &&
        declaration.key === "tool:node" &&
        (file === ".node-version" || file === ".nvmrc") &&
        status === "different"
      ) {
        decision = { strategy: "declaration-only", lock_path: null };
      } else if (
        isExactTarget &&
        (file === "package.json" || file === "pnpm-workspace.yaml") &&
        (declaration.key === "tool:node" ||
          declaration.key === "tool:pnpm" ||
          (declaration.key.startsWith("npm:") && status === "different"))
      ) {
        decision = npmLockStrategy(declaration.path, locks);
      }
    }
    changes.push({ ...declaration, target_version: target, ...decision });
  }
  return { repository, branch, base_sha: baseSha, changes, automatic_writes: false };
}
