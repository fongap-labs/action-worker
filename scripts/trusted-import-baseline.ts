// The source-import exception is centrally pinned and applies only to Delta's
// initial bootstrap commit. Subsequent PRs use their actual target-branch base.
const DELTA_BOOTSTRAP = "7556dc8dfede03053e35359f2b55dd299da1f3ee";
const DELTA_UPSTREAM = "2e39e70496aa02986ca6a820c5d497e816b69d7e";

export function engineeringOwnershipDiffBase(repository: string, base: string): string {
  return repository === "fongap-labs/delta" && base === DELTA_BOOTSTRAP ? DELTA_UPSTREAM : base;
}
