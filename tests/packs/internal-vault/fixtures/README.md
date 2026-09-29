# Test fixtures for internal-vault

This directory contains sample projects, env files, and task.json fixtures
used by the test suite.

Do NOT put real secrets here. Use obvious test placeholders only.

## Fake credential rules

Credential-shaped literals anywhere in `tests/` and `bricks/__test__/` must be:

- deterministic (same value every run, no randomness);
- format-valid for the pattern they exercise, so the Redactor and gitleaks
  see a realistic shape;
- labelled `fake` in the name or in an adjacent comment, e.g.
  `# NOT A REAL SECRET: format-valid fake GitHub PAT`.

If a fixture needs a credential format that is not covered yet, register the
format in `docs/governance/secret-redaction.md` together with its test.
