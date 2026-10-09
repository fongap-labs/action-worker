# Naming Conventions

> A name expresses its full meaning with the least necessary information: it must not depend on hidden context, and it must not repeat what is already obvious.

This file has two layers of rules: sections 1–7 apply to all managed Fongap Labs repositories; section 8 applies only to Action Worker itself. Business repositories must not copy this file; they add only real project-level naming constraints.

## 1. Naming priority

Naming priorities apply in this order:

1. **Context-independent identity**: taken out of its repository, file, workflow and call site, a name should still identify, as far as possible, the system it belongs to, its purpose and its type.
2. **Canonical vocabulary**: one concept uses one standard word.
3. **Unambiguous abbreviation**: the owning system may use a clear, recognised, unambiguous abbreviation.
4. **Minimum sufficient semantics**: keep only the information needed for identification; do not repeat what the directory, the platform or the data itself already states.
5. **Conciseness**: shorten a name only after its full meaning is in place.

Do not remove system, purpose or type information to reach a fixed number of segments, and do not mechanically pile up implementation details to make a name "more complete".

For example, an external secret:

```text
SERVICE_TOKEN
```

is understandable inside one repository, but outside it nobody can tell which system it belongs to, so it is not suitable as a new cross-repository external name.

The more complete form:

```text
AW_DISPATCH_TOKEN
```

If a system abbreviation is registered as a canonical abbreviation in this convention or in a project convention, the abbreviated form may be used.

## 2. Scope rules

### 2.1 External boundary names

These names must first of all be identifiable without context:

- GitHub Variables;
- GitHub Secrets;
- environment variables;
- workflow inputs and outputs;
- deployment parameters;
- cross-repository payload fields;
- externally documented configuration keys.

They may combine, as needed:

```text
System + Purpose + Type + Qualifier
```

This is not a fixed template and does not require all four parts. Once a name is identifiable without context, stop adding words.

A data representation (such as `JSON` or `YAML`) enters a name only when:

- the same concept exists in several representations at once;
- the representation itself is part of an external contract;
- leaving the representation out would create real ambiguity.

Otherwise, do not put the implementation format into the name.

Examples:

```text
AW_DISPATCH_TOKEN
AW_REPOSITORY_POLICY
AW_AI_AGENT_CONFIG
AW_AI_AGENT_WRITING_MODEL
AW_AI_AGENT_WRITING_PHARMA_BRIEF_MODEL
AIG_ACCESS_KEY_AGENT
AIG_TIER1_NODES_01
AIG_USAGE_D1_ID
CLOUDFLARE_ACCOUNT_ID
```

Add a qualifier only when several configurations of the same kind really exist, for example `AIR`, `PRO`, `MAX`.

Runtime-derived names are allowed when they are generated from one canonical configuration source rather than configured independently. For AI Agent model routing, `AW_AI_AGENT_CONFIG` is the only configurable authority; names such as `AW_AI_AGENT_WRITING_MODEL` and `AW_AI_AGENT_WRITING_PHARMA_BRIEF_MODEL` are generated runtime environment variables and must not be defined as Repository Variables.

Business repositories may identify a scoped owner through the directory that owns the configuration. For external configuration under a recognized business scope such as:

```text
projects/<owner>/
apps/<owner>/
services/<owner>/
tools/<owner>/
crates/<owner>/
skills/<owner>/
```

the normalized owner name is a valid external prefix. Examples:

```text
projects/MarketBrief/.env.variables → MARKETBRIEF_*
services/server-edge/.env.example → SERVER_EDGE_*
```

This does not permit generic names such as `ARTIFACT_REPOSITORY` or `OUTPUT_DIR`; the external name must still carry the scoped owner identity.

### 2.2 Local source identifiers

Function parameters, local variables, private fields and short-lived internal identifiers may rely on their lexical context and do not need to repeat the owning system's prefix.

For example, in the request module of `ai-gateway`:

```text
model
request
policy
isEnabled
```

is better than:

```text
aiGatewayRequestModel
aiGatewayRequestPolicy
```

Local names must still be accurate and unambiguous and follow the canonical vocabulary.

## 3. Abbreviations

Two kinds of abbreviations are allowed:

### 3.1 Industry/platform abbreviations

Widely recognised, unambiguous abbreviations may be used directly, for example:

```text
API
URL
URI
ID
CI
LLM
HTTP
HTTPS
JSON
YAML
SQL
D1
KV
GH
CF
AWS
GCP
```

### 3.2 Project/system abbreviations

An abbreviation of a Fongap Labs system may be used in external configuration only when all of these hold:

- it is registered in the shared convention or in a long-lived project convention;
- one abbreviation maps to one system;
- it does not conflict with a common industry meaning;
- a new member can look up its definition without relying on the context of a particular repository.

Inventing an abbreviation on the spot to shorten a name is forbidden.

If an abbreviation has no stable consensus, use the full system name.

Current canonical Fongap Labs system abbreviations:

| System | Abbreviation |
|---|---|
| Action Worker | `AW` |
| AI Gateway | `AIG` |
| App Source | `APP_SOURCE` |
| Delta | `DELTA` |
| Server Edge | `SERVER_EDGE` |

A project that adds a system abbreviation changes this table first and then uses it in the business repository.

## 4. Source identifiers

- New or changed identifiers in Python, Rust and TypeScript/TSX follow the same semantic principles;
- local functions and parameters prefer brevity, usually about three semantic segments, but complete meaning comes first;
- booleans use an `is / has / can / should` semantic prefix;
- `impl / helper / common / misc / shared` are forbidden as vague responsibility words; `new / final / latest / temp / tmp` used as engineering lifecycle labels are forbidden in long-lived control-plane names, but are allowed in a clearly defined domain concept (for example `temp_access`);
- tests, generated code and third-party code may be exempted by the project's own checker.

"Three segments" is only a local readability preference and must never be used to truncate an external configuration name.

## 5. Configuration type words

External configuration should keep, as far as possible, a standard word that expresses the data or resource type, for example:

```text
TOKEN
KEY
SECRET
ID
URL
URI
PATH
FILE
DIR
JSON
YAML
NAME
REF
SHA
VERSION
TIMEOUT
DELAY
INTERVAL
LIMIT
COUNT
SIZE
BYTES
PORT
HOST
REGION
REPOSITORY
MODE
CONFIG
```

A credential must not use `PAT` as a new standard type word; use the more general and understandable `TOKEN` or `KEY`, unless the native field name of a third-party platform must stay unchanged.

## 6. Engineering language

An engineering diff must be in English. The diff means engineering content that is added or changed, including:

- identifiers;
- code comments;
- workflow names and steps;
- logs and errors;
- test descriptions;
- configuration keys;
- PR titles and engineering summaries;
- CHANGELOG entries.

Mixing Chinese and English engineering text in one engineering diff is forbidden, and so is adding Chinese engineering comments, logs, error messages, test descriptions or CHANGELOG entries.

The only exceptions are:

- user-facing UI copy;
- localization resources;
- documentation that a business repository explicitly maintains in Chinese (Action Worker itself has no such documentation; see section 8).

The exceptions never extend to the CHANGELOG, PR titles, code comments, workflows, logs, error messages or test descriptions; those are always in English.

## 7. Files, terms and verbs

- workflow / control script / test files use `kebab-case`;
- governance documents use `UPPER_SNAKE_CASE.md`;
- a file name expresses only the file's own responsibility and does not repeat context the directory already provides;
- long-lived names avoid lifecycle words and vague words.

Canonical terms:

| Concept | Term |
|---|---|
| machine contract | `contract` |
| primary change category | `change type` |
| technical changed region | `change area` |
| fast semantic routing | `triage` |
| code review | `review` |
| review result | `finding` |
| deterministic rule | `policy` |
| policy exception | `override` |
| project evidence | `context` |
| model supplier | `provider` |
| routing endpoint | `gateway` |
| work unit | `task` |
| dispatch | `dispatch` |
| state | `status` |
| validation | `validate / validation` |
| publication | `release` |
| Git tag | `tag` |
| continuous integration | `CI` |
| execution request | `execution request` |
| project execution declaration | `execution manifest` |
| generic execution unit | `executor` |
| requested permission | `capability request` |
| granted permission | `capability grant` |
| abstract compute requirement | `runner profile` |
| runner selection component | `runner resolver` |
| compute provider class | `runner backend` |

Preferred verbs:

```text
get load fetch create update delete validate detect resolve evaluate
build generate handle execute publish summarize
```

## 8. Action Worker only

Action Worker is a generic governance and execution plane. Stable authority remains in:

```text
docs/
contracts/
policies/
rules/
scripts/
tests/
```

Platform-required `.github/workflows/` is an exception.

When the execution framework grows, repository-agnostic implementation layers such as `executors/`, `runners/`, or `adapters/` are allowed if they represent reusable capabilities and are driven by common contracts.

Action Worker must not introduce repository-specific configuration structures such as:

```text
projects/<repository-or-product>/
profiles/<repository-or-product>/
<repository-name>/
```

A generic adapter is allowed; an adapter whose purpose is effectively “special-case repository X” is not.

This restriction does **not** apply to business repositories. A product repository may legitimately use `projects/`, `apps/`, `crates/`, `tools/`, `skills/`, `output/`, or other semantically correct project-specific directories.

Action Worker CI enforces its own filename and architecture restrictions. Business repositories may add stricter project-specific naming checks, but must not redefine the shared vocabulary.

For the unified execution plane, business repositories use `runner_profile` as the external contract field. They must not expose concrete infrastructure names such as GitHub runner image names, `self-hosted` labels, runner groups, hostnames, or cloud instance names as project-level configuration. `runner profile` describes requirements; `runner resolver` selects the actual `runner backend`.

### 8.1 Workflow file names

Workflow and shell file names have at most three kebab-case segments (`scripts/validate-naming-rules.ts` and `scripts/validate-source-naming.py` enforce this in every managed repository). Within that limit, `tests/workflow-naming.test.ts` checks these rules for Action Worker's own workflows:

- A workflow started by `repository_dispatch` and not by `push` takes the most complete name that fits in three segments: `handle-<subject>-dispatch.yml`, then `<subject>-dispatch.yml`, then `<subject>.yml`. The subject is the event name without `run-`. For example:

  ```text
  run-task                 → handle-task-dispatch.yml   (one-word subject: the full form fits)
  run-security-scan        → security-scan-dispatch.yml (two words: handle is dropped)
  run-source-script-deploy → source-script-deploy.yml   (three words: only the subject fits)
  ```

  `handle` marks the receiving side where it fits; senders are named `dispatch-*` (for example `scripts/dispatch-central-ci.ts`).
- A scheduled reconciliation workflow that scans managed repositories and dispatches work is named `<subject>-intake.yml` (for example `pr-intake.yml`).
- The display name (`name:`) spells out the file name word by word, with `pr` and `ci` written as `PR` and `CI` (`pr-intake.yml` is "PR Intake").
- A file that keeps an older name is listed in the test with the reason renaming is not worth it. Today these are `handle-pr-dispatch.yml` (a CI Evidence trust anchor in `scripts/ci-evidence.ts`) and `handle-pr-review.yml` (counted by the AI Review queue).

### 8.2 Documentation language

Every document in Action Worker that people and agents work from — `CLAUDE.md`, `AGENTS.md`, `README.md`, `SECURITY.md`, `docs/`, `skills/` — is written in English. Chinese appears only in localization files named `*.zh-CN.md` (`README.zh-CN.md`, `docs/README.zh-CN.md`, `SECURITY.zh-CN.md`), which translate an English original and never carry rules the original does not have. `tests/documentation-language.test.ts` checks this.

This rule is for Action Worker only. The engineering language check that runs on business repository pull requests still exempts Markdown, so a business repository may keep documentation it explicitly maintains in Chinese.

## 9. Short version

```text
External name = identifiable without repository context
Use minimum sufficient semantics
System + Purpose + Type + Qualifier is a guide, not a fixed template
Do not encode JSON/YAML unless representation is part of the contract
Semantic completeness > segment count
Recognized abbreviations are allowed; ad-hoc abbreviations are not
Local source names may rely on lexical context
One concept = one standard term
Boolean = is / has / can / should
Engineering diff = English
CHANGELOG / PR title = English
Action Worker documentation = English; Chinese only in *.zh-CN.md
Plain data content files (.txt / .csv / .tsv) are language-exempt
```
