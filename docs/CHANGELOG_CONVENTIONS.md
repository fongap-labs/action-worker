# CHANGELOG Conventions

Action Worker uses one change classification across PRs, agents, the CHANGELOG and releases.

## 0. Language

PR titles, CHANGELOG entries and the engineering summary of release notes must be in English.

Forbidden:

- CHANGELOG entries in Chinese;
- CHANGELOG entries that mix Chinese and English;
- PR summaries in Chinese;
- each repository choosing its own CHANGELOG language.

Chinese may appear only in user-facing UI copy and localization resources (for example `*.zh-CN.md`); it never enters an engineering CHANGELOG.

## 1. The one change classification

Only these 11 types are allowed:

| Type | Meaning |
|---|---|
| `feat` | a new feature or capability |
| `fix` | a defect fix |
| `docs` | documentation only |
| `style` | formatting or style only, no logic change |
| `refactor` | restructuring with no new feature and no defect fix |
| `perf` | performance improvement |
| `test` | tests added or adjusted |
| `build` | build, dependencies, packaging |
| `ci` | CI/CD, GitHub Actions |
| `chore` | other maintenance work |
| `revert` | reverting an earlier change |

A second classification such as Added, Changed, Fixed or Internal must not be defined.

## 2. Change attributes

These are not types, only attributes:

```text
breaking
security
migration
```

A PR has exactly one main type and may carry several attributes.

For example:

```text
type: feat
attributes: breaking, migration
```

or:

```text
type: fix
attributes: security
```

## 3. PR title

A PR title follows the Conventional Commits style:

```text
type: summary
type(scope): summary
type!: summary
type(scope)!: summary
```

Examples:

```text
feat: add repository allowlist validation
fix(router): stop retrying a disabled provider
refactor: simplify PR plan resolution
feat(auth)!: replace legacy authentication contract
```

Rules:

- the type comes from the 11 types above;
- the scope is optional and only describes the affected area;
- `!` marks a breaking change;
- the summary is in English and describes the result; meaningless summaries such as `update files` or `misc changes` are not allowed;
- a PR has only one main type.

## 4. CHANGELOG file

Every project uses:

```text
CHANGELOG.md
```

The file contains at least:

```markdown
# Changelog

## [Unreleased]
```

Every entry that has not been released goes under `[Unreleased]`.

There are no Added / Changed / Fixed sections and no conversion between classifications.

## 5. CHANGELOG entries

Entries use the same types directly:

```markdown
- feat: validate the PR repository allowlist.
- fix [security]: stop the PR sandbox from inheriting central secrets.
- feat [breaking, migration]: replace the legacy authentication configuration format.
- perf: reduce provider routing latency.
```

Format:

```text
- type: summary
- type [attribute]: summary
- type [attribute, attribute]: summary
```

Allowed attributes:

```text
breaking
security
migration
```

When a PR title uses `!`, its CHANGELOG entry must include `breaking`.

## 6. When a CHANGELOG entry is required

Required by default for:

```text
feat
fix
perf
revert
```

and for every change with one of these attributes:

```text
breaking
security
migration
```

Not required by default for:

```text
docs
style
refactor
test
build
ci
chore
```

If a so-called `refactor`, `ci` or `build` change actually changes external behaviour, the classification itself is wrong. Reclassify it as `feat`, `fix`, `perf` and so on instead of bypassing the rule with an exception.

## 7. Default agent duties

An ordinary PR does not need a person to decide each item.

After the code is done, the executing agent must:

1. read the final diff instead of guessing from the original task description;
2. choose exactly one main type from the 11;
3. decide whether the breaking / security / migration attributes apply;
4. set or correct the PR title;
5. decide by this convention whether `CHANGELOG.md` must be updated;
6. write the CHANGELOG content in English, describing only the actual result and not listing changed files.

The review agent / critic must check again:

- whether the type matches the actual diff;
- whether breaking was left out;
- whether security / migration were left out;
- whether a PR that requires a CHANGELOG entry is missing one;
- whether the CHANGELOG is in English and describes real behaviour rather than the implementation process.

Escalate to a person only when the evidence is insufficient, when the business meaning cannot be determined from code, tests or documentation, or when an irreversible high-risk decision is involved.

## 8. Forbidden

Forbidden summaries:

```text
update files
fix bug
refactor code
misc changes
various improvements
```

Also forbidden:

- declaring several main types in one PR;
- using `chore` to hide a real feat / fix / breaking change;
- using security as the main type;
- using breaking as the main type;
- using a second Added / Changed / Fixed classification;
- silently leaving out a CHANGELOG entry because the agent is unsure.

## 9. Release

Release notes consume the same types directly.

The presentation layer may hide low-value types, for example:

```text
docs
style
refactor
test
build
ci
chore
```

but the underlying classification is never converted or renamed.

## 10. Shortest rule

> One PR, one type; PR titles and the CHANGELOG are in English; types follow Conventional Commits; breaking / security / migration are only attributes; the CHANGELOG keeps no second classification.
