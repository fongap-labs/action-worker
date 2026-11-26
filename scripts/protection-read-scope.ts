import { GithubHttpError, GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

/** An unreadable protection rule is an infrastructure error, not an unauthorized write. */
export class ProtectionReadError extends CliError {
  constructor(message: string) {
    super(message, 77);
  }
}

/** Keep the existing admin-ops credential out of inherited subprocess environments. */
export function takeProtectionReadToken(): string {
  const token = process.env.AW_PROTECTION_READ_TOKEN ?? "";
  delete process.env.AW_PROTECTION_READ_TOKEN;
  return token;
}

/** Only exact policy-scoped ruleset GETs may use the admin-ops credential. */
export function withProtectionReads(
  reader: GithubReader,
  token: string,
  repositories: readonly string[]
): GithubReader {
  const allowed = new Set(repositories);
  const privileged = new GithubReader(reader.apiUrl, token);
  const ordinary = reader.get.bind(reader);
  reader.get = async (path) => {
    const [pathname, query] = path.split("?");
    const rules = /^repos\/([^/]+\/[^/]+)\/rulesets(?:\/([1-9][0-9]*))?$/.exec(pathname ?? "");
    if (!rules) return ordinary(path);
    const expected = rules[2] ? "includes_parents=false" : "includes_parents=false&per_page=100";
    if (query !== expected || path !== `${pathname}?${expected}`) {
      throw new ProtectionReadError("Protection read query is not authorized.");
    }
    if (!allowed.has(rules[1] ?? "")) {
      throw new ProtectionReadError("Protection read is outside the approved repository scope.");
    }
    if (!token) {
      throw new ProtectionReadError("Missing admin-ops protection read credential.");
    }
    let result: unknown;
    try {
      result = await privileged.get(path);
    } catch (error) {
      if (
        error instanceof GithubHttpError &&
        (error.status === 404 || error.kind === "permission")
      ) {
        throw new ProtectionReadError(
          `Cannot read managed ruleset ${rules[2] ? "detail" : "list"} (HTTP ${error.status}); verify admin-ops repository access and Administration write.`
        );
      }
      throw error;
    }
    if (rules?.[2] && (!isJsonRecord(result) || !Array.isArray(result.bypass_actors))) {
      throw new ProtectionReadError(
        "GitHub did not disclose bypass_actors; protection cannot be verified."
      );
    }
    return result;
  };
  return reader;
}
