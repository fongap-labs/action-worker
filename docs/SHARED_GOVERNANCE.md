# Fongap Labs Shared Governance

This file defines the shared engineering governance of the managed Fongap Labs repositories. Whenever a rule applies to two or more repositories, it is maintained in Action Worker first; a business repository keeps only the product, architecture, runtime and boundary rules that belong to that project alone.

## 1. Authority boundary

```text
Action Worker
= shared governance
+ machine contracts / policies / rules
+ unified execution plane
+ PR / CI / Review / Build / Release / Deploy / Task governance
+ runner resolution and execution provenance

Business repository
= product source
+ product tests
+ project architecture
+ project-specific scripts and boundaries
+ execution manifest
+ thin integration workflows
```

A business repository must not copy the generic naming, change classification, PR gate, execution governance, release governance, Repository Policy or agent engineering rules that Action Worker already defines.

Public and private repositories use the same execution architecture. Apart from the thinnest dispatch and the bridge checks the GitHub platform requires the target repository to create, heavy execution — CI, test, build, AI Review, release, deploy and scheduled tasks — goes into Action Worker. Repository visibility may only affect access and platform protection features; it must never form a second execution path.

The unified execution boundary is defined by [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md); the runner abstraction and the self-hosted boundary are defined by [RUNNER_POLICY.md](RUNNER_POLICY.md).

## 2. Shared rules

Action Worker maintains these rules for everyone:

- repository governance and merge defaults;
- naming conventions;
- changelog and PR change classification;
- English-only engineering diff, PR titles, CHANGELOG entries and release summaries;
- common development and validation rules;
- PR governance and merge-gate contract;
- unified execution contract for public and private repositories;
- central CI / build / review / release / deploy / task execution;
- runner profiles, runner resolution and self-hosted boundaries;
- release and deploy governance;
- cross-repository trust and secret boundaries;
- common Agent entry and precedence rules;
- cross-repository language and runtime convergence rules.

Language governance follows the same long-term principle: a small kernel and a large framework come before any single-language goal. The choice of language follows module boundaries. When performance, security, functionality, compatibility and maintainability do not drop, unnecessary languages and runtimes are removed first, but rewriting a stable implementation with clear boundaries only to "unify the stack" is forbidden. Duplicate authorities, duplicate state and duplicate protocols across languages are removed first.

## 3. Project-local rules

A business repository keeps only the rules that cannot exist without that project, for example:

- product positioning and product boundary;
- runtime / protocol / public API architecture;
- repository-specific dependency rules;
- product-specific security invariants;
- project release compatibility;
- capability or extension boundaries;
- project-specific build, package and deploy implementation.

The test:

> If a rule still applies to other repositories once the project name is removed, it usually should not stay in the business repository.

## 4. Authority order

On conflict, this order applies:

```text
machine contracts / policies / rules
        ↓
Action Worker shared governance
        ↓
project architecture / project boundary
        ↓
project implementation documentation
        ↓
README / examples
```

A project rule may tighten a shared rule, but must not bypass the shared security boundary, the PR gate or the cross-repository credential boundary.

AI Review is not a shared gate. It only reviews, suggests and finds problems; whether it is enabled, whether it succeeds and how many problems it finds can never replace or change the deterministic CI / PR / Security gates.

The Security Gate is a shared hard boundary. It is executed by the deterministic checks of Action Worker and covers public and private repositories.

`validate-merge` is the only merge authority. AI Review runs after the deterministic gate conclusion and produces only advisory findings.

The Main Write Guard is the main-provenance hard boundary shared by all managed repositories. A `main` SHA that cannot be proven to come from a legitimate PR merge is untrusted and cannot be released, deployed, published or used for privileged execution. See [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md) for the detailed rules.

## 5. Agent entry

Every managed business repository keeps two very thin entry points:

```text
AGENTS.md
  ↓
CLAUDE.md
  ↓
Action Worker shared governance
  ↓
project-specific authoritative documents
```

`AGENTS.md` only points onward and copies no rules. The business repository `CLAUDE.md` lists only the shared rule entry points, the project's authoritative documents and the few prohibitions that belong to the project alone.

## 6. Machine enforcement

Documentation explains the rules, but real governance is executed by machine contracts:

```text
contracts/   input/output contracts
policies/    deterministic policy
rules/       AI review policy
actions/     merge enforcement
workflows/   orchestration
tests/       governance regression tests
```

An important rule that exists only in Markdown, without a matching machine constraint, has not closed its governance loop yet.

## 7. Platform capability

Governance goals are described separately from GitHub plan features.

The Action Worker gate holds for every managed repository; native GitHub rulesets, branch protection or the Administration API are enabled only within the plan and permissions the current repository has. Private repositories of a GitHub Free organization have no enforced ruleset / protected-branch protection, so in those repositories the central gate is a process constraint and not a hard GitHub platform gate. Missing platform features are never a reason to bypass the central gate, and documentation must never assume that private repositories already have the same enforced protection as public ones.

## 8. Documentation readability

Documentation in every Fongap Labs repository falls into two kinds, each with its own reader and writing requirements:

### Machine-read documents (rigorous)

The readers are AI agents and machine checks. This covers `SKILL.md`, `contracts/`, `policies/` and `rules/`.

Requirements:

1. **English**.
2. **Precise and unambiguous**: every rule has exactly one reading; vague wording such as "as appropriate" or "depending on the situation" is forbidden.
3. **Structured**: use numbering, code blocks and explicit conditional branches (`if...then`); do not rely on inference from context.
4. **Verifiable**: a rule a machine can check has a matching contract test.

### Human-read documents (beginner-friendly)

The reader is someone without project background. This covers `README.md`, guides and the human-facing parts of governance documents.

Requirements:

1. **English**.
2. **Say "what this is" before "how to do it"**: every document opens with one or two sentences about its purpose instead of jumping straight into implementation details.
3. **Explain every term**: the first time a term such as frontmatter, dispatch, bootstrap, gate or manifest appears, explain it in brackets or a short sentence.
4. **Use examples, not abstract descriptions**: whatever a concrete example can show, do not describe with rule text alone. Put examples in code blocks.
5. **Do not assume the reader knows GitHub Actions**: explain concepts such as workflow, runner and dispatch with everyday analogies.
6. **Layer the structure**: first a quick explanation for beginners, then the technical details for maintainers, separated by headings.
7. **One paragraph says one thing**: anything that is not finished after five lines becomes a list or gets subheadings.

This rule applies to Action Worker and every managed business repository. A business repository's `CLAUDE.md`, `README.md` and project documentation follow it too. In Action Worker, Chinese appears only in `*.zh-CN.md` localization files (see [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) section 8.2).
