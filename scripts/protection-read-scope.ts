import { GithubReader, isJsonRecord } from "./github-api.ts";
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

/** Only exact policy-scoped protection GETs may use the admin-ops credential. */
export function withProtectionReads(
  reader: GithubReader,
  token: string,
  repositories: readonly string[],
  approvalRepository?: string
): GithubReader {
  const allowed = new Set(repositories);
  const privileged = new GithubReader(reader.apiUrl, token);
  const ordinary = reader.get.bind(reader);
  reader.get = async (path) => {
    const rules =
      /^repos\/([^/]+\/[^/]+)\/rulesets(?:\/([1-9][0-9]*))?\?includes_parents=false(?:&per_page=100)?$/.exec(
        path
      );
    const environment = /^repos\/([^/]+\/[^/]+)\/environments\/branch-transfer$/.exec(path);
    if (!rules && !environment) return ordinary(path);
    if (
      (rules && !allowed.has(rules[1] ?? "")) ||
      (environment && environment[1] !== approvalRepository)
    ) {
      throw new ProtectionReadError("Protection read is outside the approved repository scope.");
    }
    if (!token) {
      throw new ProtectionReadError("Missing admin-ops protection read credential.");
    }
    const result = await privileged.get(path);
    if (rules?.[2] && (!isJsonRecord(result) || !Array.isArray(result.bypass_actors))) {
      throw new ProtectionReadError(
        "GitHub did not disclose bypass_actors; protection cannot be verified."
      );
    }
    return result;
  };
  return reader;
}
