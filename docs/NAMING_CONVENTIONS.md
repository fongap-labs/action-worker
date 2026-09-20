# Naming Conventions

> 一个概念，一个标准词；一个名称，最多三段。

本文件包含两层规则：第 1–6 节适用于 Fongap Labs 受管仓库；第 7 节仅适用于 Action Worker 自身。业务仓不得复制本文件，只补充真正的项目级命名约束。

## 1. Shared core rules

```text
Object: Object + Role + Qualifier
Action: Verb + Object + Qualifier
```

- 最多三段，不要求必须三段；
- 两段能说清，不用三段；
- 不用拼词或自造缩写规避段数；
- 标准缩写可作为一段，例如 `PR`、`API`、`URL`、`CI`、`ID`、`LLM`；
- 一个概念只使用一个标准词。

## 2. Source identifiers

- Python、Rust、TypeScript/TSX 的新增或修改标识符遵循同一语义原则；
- 函数和参数优先控制在三段内；
- Boolean 使用 `is / has / can / should` 语义前缀；
- 禁止用 `impl / helper / common / misc / shared / new / final / latest / temp / tmp` 作为模糊长期名称；
- 测试、生成代码或第三方代码可由项目自己的检查器决定是否豁免。

## 3. Engineering language

工程 diff 必须使用英文。这里的 diff 指新增或修改的工程内容，包括：

- identifiers;
- code comments;
- workflow names and steps;
- logs and errors;
- test descriptions;
- configuration keys;
- PR titles and engineering summaries;
- CHANGELOG entries.

禁止在同一工程 diff 中混用中文和英文工程文本，也禁止新增中文工程注释、日志、错误信息、测试描述或 CHANGELOG 条目。

例外仅限：

- user-facing UI copy;
- localization resources;
- explicitly Chinese-maintained documentation.

例外不扩展到 CHANGELOG、PR 标题、代码注释、workflow、日志、错误信息或测试描述；这些始终使用英文。

## 4. Files and documents

- workflow / control script / test files use `kebab-case`;
- governance documents use `UPPER_SNAKE_CASE.md`;
- 文件名只表达文件自己的职责，不重复目录已经提供的上下文；
- 长期名称避免生命周期词和模糊词。

## 5. Canonical terms

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

## 6. Preferred verbs

```text
get load fetch create update delete validate detect resolve evaluate
build generate handle execute publish summarize
```

## 7. Action Worker only

Action Worker is a generic control plane, so its own long-lived resource directories are limited to:

```text
docs/
contracts/
policies/
rules/
scripts/
tests/
```

Platform-required `.github/workflows/` is an exception.

Action Worker must not introduce repository-specific configuration structures such as:

```text
projects/
adapters/
profiles/
```

This restriction does **not** apply to business repositories. A product repository may legitimately use `projects/`, `apps/`, `crates/`, `tools/`, `skills/`, `output/`, or other semantically correct project-specific directories.

Action Worker CI enforces its own filename and architecture restrictions. Business repositories may add stricter project-specific naming checks, but must not redefine the shared vocabulary.

## 8. Short version

```text
One concept = one standard term
Prefer ≤ 3 semantic segments
Boolean = is / has / can / should
Shared naming lives here
Project-specific naming stays in the project
Engineering diff = English
CHANGELOG / PR title = English
Action Worker directory restrictions apply only to Action Worker
```
