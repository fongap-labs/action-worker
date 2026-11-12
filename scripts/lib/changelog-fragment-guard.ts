import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isGithubMissing,
  isJsonRecord,
} from "../github-api.ts";
import { CliError } from "../runtime-command.ts";

type ReadGithub = (path: string, token: string) => Promise<unknown>;

/**
 * Check existing legacy changelog fragments before preparing a staged release.
 * Preserve the caller's exact URL/ref, error message, and 404 handling.
 */
export async function ensureNoLegacyChangelogFragments(
  path: string,
  token: string,
  errorMessage: string,
  read: ReadGithub = getGithubJson
): Promise<void> {
  try {
    const entries = getJsonArray(await read(path, token));
    if (
      entries.some(
        (item) =>
          isJsonRecord(item) && item.type === "file" && getJsonString(item, "name").endsWith(".md")
      )
    ) {
      throw new CliError(errorMessage, 65);
    }
  } catch (error) {
    if (isGithubMissing(error)) return;
    throw error;
  }
}
