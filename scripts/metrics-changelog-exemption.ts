import { applyIncrement, renderMetrics } from "./update-work-metrics.ts";

const metricsTitle = "chore(metrics): update work metrics";
const controlRepository = "fongap-labs/action-worker";
const startMarker = "<!-- work-metrics:start -->";
const endMarker = "<!-- work-metrics:end -->";

/**
 * An exception for machine-produced badge count updates, not a general
 * CHANGELOG bypass. The trusted target, exact title, changed file and
 * canonical badge rendering all have to match.
 */
export function isGeneratedMetricsOnlyChange(options: {
  title: string;
  repository: string;
  changedPaths: readonly string[];
  baseReadme: string;
  headReadme: string;
}): boolean {
  const { title, repository, changedPaths, baseReadme, headReadme } = options;
  if (
    title !== metricsTitle ||
    repository !== controlRepository ||
    changedPaths.length !== 1 ||
    changedPaths[0] !== "README.md" ||
    baseReadme === headReadme
  ) {
    return false;
  }
  for (const marker of [startMarker, endMarker]) {
    if (baseReadme.split(marker).length !== 2 || headReadme.split(marker).length !== 2) {
      return false;
    }
  }
  try {
    const counts = applyIncrement(headReadme, {
      dispatch: 0,
      pr_governance: 0,
      ai_review: 0,
      release_governance: 0,
    });
    if (
      !Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0) ||
      counts.gate !== counts.pr_governance
    ) {
      return false;
    }
    return renderMetrics(baseReadme, counts, controlRepository) === headReadme;
  } catch {
    return false;
  }
}
