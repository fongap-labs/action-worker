---
name: security-remediation
description: Vulnerability patch governance, dependency CVE updates, and security alert remediation with minimal version steps and taint-source validation. Use for security advisories, CVE remediation, and secret-leak response.
domain: coding
operations: [task]
---

# Security Remediation

Use for security vulnerability fixes, dependency CVE updates, security alert remediation, and secret-leak response.

For a non-security defect, use `bug-fix`. This skill applies when the trigger is a security advisory, a vulnerability scan finding, or a secret-leak event.

## 1. Verify advisory authenticity

Before fixing anything:

- confirm the advisory source (CVE, GHSA, internal report, Dependabot alert);
- confirm the advisory applies to the version in use;
- confirm the vulnerable code path is reachable in the current configuration.

A vulnerability in a dependency that is not called does not require an emergency fix. Record the assessment.

## 2. Assess impact scope

Identify:

- affected versions and environments;
- exposed attack surface (public endpoint, internal API, build-time only);
- data at risk (user data, secrets, credentials, audit records);
- existing mitigations already in place (WAF, network policy, input validation upstream).

Record the scope before choosing a fix strategy.

## 3. Choose the fix strategy by priority

```text
Secret leak     → rotate credentials first, then fix the leak path
Injection (SQLi/XSS/command) → validate and sanitize at the input source
Auth bypass     → fix the authorization check at the owning boundary
Dependency CVE  → minimal version step (see section 4)
Logic flaw      → fix the root cause at the owner
```

Do not apply a fix that widens the attack surface or introduces a new trust boundary.

## 4. Minimal version step

For dependency vulnerabilities:

- prefer the smallest version bump that satisfies the advisory (patch over minor, minor over major);
- record the chosen version and why it satisfies the advisory;
- do not jump a major version without testing the full consumer surface;
- check for transitive dependency conflicts introduced by the bump;
- verify the lockfile change matches the declared trigger paths.

If the minimal patch version is unavailable, state the gap and the risk of the next available version.

## 5. Taint-source validation

For injection-class vulnerabilities (SQLi, XSS, command injection, path traversal):

- validate and sanitize at the input boundary, not at the consumption site;
- use typed validation or allow-lists, not regex deny-lists;
- parameterize queries; do not concatenate user input into SQL or shell commands;
- encode output at the rendering boundary;
- confirm the fix covers every entry point to the vulnerable sink.

A deny-list that blocks known payloads is not a fix. The next payload bypasses it.

## 6. Secret rotation

If the vulnerability involves exposed credentials:

1. rotate the exposed credential first — before committing the fix;
2. revoke old tokens, keys, or passwords;
3. update all consumers of the rotated credential;
4. scan the repository history for the secret and purge it if required;
5. fix the code path that leaked the secret.

Do not commit a fix for the leak path while the old credential is still valid.

## 7. Regression protection

- add a test that exercises the vulnerability trigger (PoC at the seam);
- confirm the test fails before the fix and passes after;
- run the full affected test suite — no regressions;
- do not suppress or weaken existing security tests to obtain green status.

## 8. Coordinated disclosure

If the vulnerability is not yet public:

- follow the project's disclosure policy;
- do not publish details in PR descriptions, commit messages, or public issues before the embargo lifts;
- reference the advisory by ID only, not by exploit details.

## 9. Completion

The remediation is complete when:

- advisory authenticity and impact scope are recorded;
- fix targets the root cause at the owning boundary;
- minimal version step or taint-source fix is applied;
- credentials are rotated (if applicable);
- regression test covers the vulnerability trigger;
- no existing security test was weakened;
- disclosure constraints are respected.
