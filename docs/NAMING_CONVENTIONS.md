# Naming Conventions

> 名称使用最少必要信息表达完整语义；既不能依赖隐藏上下文，也不要重复显而易见的信息。

本文件包含两层规则：第 1–7 节适用于 Fongap Labs 受管仓库；第 8 节仅适用于 Action Worker 自身。业务仓不得复制本文件，只补充真正的项目级命名约束。

## 1. Naming priority

命名优先级按以下顺序执行：

1. **Context-independent identity**：名称脱离仓库、文件、workflow 和调用位置后，仍应尽可能识别所属系统、用途和类型。
2. **Canonical vocabulary**：一个概念只使用一个标准词。
3. **Unambiguous abbreviation**：所属系统可以使用明确、公认、无歧义的缩写。
4. **Minimum sufficient semantics**：只保留识别所必需的信息，不重复目录、平台或数据本身已经明确表达的语义。
5. **Conciseness**：在完整语义成立后再缩短名称。

不得为了满足固定段数而删除系统、用途或类型信息；也不得为了“更完整”机械叠加实现细节。

例如，外部 Secret：

```text
SERVICE_TOKEN
```

在某个仓库里可理解，但离开仓库后无法判断所属系统，因此不适合作为新的跨仓外部名称。

更完整的形式：

```text
AW_DISPATCH_TOKEN
```

如果某个系统缩写已在本规范或项目规范中登记为 canonical abbreviation，也可以使用缩写形式。

## 2. Scope rules

### 2.1 External boundary names

以下名称必须优先满足“脱离上下文仍可识别”：

- GitHub Variables;
- GitHub Secrets;
- environment variables;
- workflow inputs and outputs;
- deployment parameters;
- cross-repository payload fields;
- externally documented configuration keys.

可按需要组合：

```text
System + Purpose + Type + Qualifier
```

这不是固定模板，也不是要求四部分全部出现。名称达到“脱离上下文仍可识别”后，应停止继续加词。

数据表示形式（如 `JSON`、`YAML`）只有在以下情况才进入名称：

- 同一概念同时存在多种表示形式；
- 表示形式本身属于外部契约；
- 不写表示形式会造成真实歧义。

否则不要把实现格式写进名称。

例：

```text
AW_DISPATCH_TOKEN
AIG_ACCESS_KEY_AIR
AIG_TIER1_NODES_01
AIG_USAGE_D1_ID
CLOUDFLARE_ACCOUNT_ID
```

Qualifier 仅在确有多个同类配置时增加，例如 `AIR`、`PRO`、`MAX`。

### 2.2 Local source identifiers

函数参数、局部变量、私有字段和短生命周期内部标识符可以依赖代码词法上下文，不要求重复所属系统前缀。

例如在 `ai-gateway` 的 request 模块中：

```text
model
request
policy
isEnabled
```

比：

```text
aiGatewayRequestModel
aiGatewayRequestPolicy
```

更合适。

局部名称仍应准确、无歧义，并遵守 canonical vocabulary。

## 3. Abbreviations

允许使用两类缩写：

### 3.1 Industry/platform abbreviations

可直接使用广泛公认、无歧义的缩写，例如：

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

Fongap Labs 自有系统缩写只有在以下条件同时满足时才能用于外部配置：

- 已在共享规范或项目级长期规范中登记；
- 一个缩写只对应一个系统；
- 不与行业常见含义冲突；
- 新成员无需依赖某个仓库上下文即可查到定义。

禁止为缩短名称临时发明缩写。

如果缩写没有稳定共识，使用完整系统名。

当前 Fongap Labs canonical system abbreviations：

| System | Abbreviation |
|---|---|
| Action Worker | `AW` |
| AI Gateway | `AIG` |

项目若新增系统缩写，应先修改本表，再在业务仓使用。

## 4. Source identifiers

- Python、Rust、TypeScript/TSX 的新增或修改标识符遵循同一语义原则；
- 局部函数和参数优先简洁，通常控制在约三段语义内，但语义完整优先；
- Boolean 使用 `is / has / can / should` 语义前缀；
- 禁止用 `impl / helper / common / misc / shared / new / final / latest / temp / tmp` 作为模糊长期名称；
- 测试、生成代码或第三方代码可由项目自己的检查器决定是否豁免。

“三段”只是一项局部可读性偏好，不得用于强制截断外部配置名称。

## 5. Configuration type words

外部配置应尽可能保留能表达数据类型或资源类型的标准词，例如：

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

凭据不得用 `PAT` 作为新的标准类型词；统一使用更通用且可理解的 `TOKEN` 或 `KEY`，除非第三方平台的原生字段名必须保持不变。

## 6. Engineering language

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

## 7. Files, terms and verbs

- workflow / control script / test files use `kebab-case`;
- governance documents use `UPPER_SNAKE_CASE.md`;
- 文件名只表达文件自己的职责，不重复目录已经提供的上下文；
- 长期名称避免生命周期词和模糊词。

Canonical terms：

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

Preferred verbs：

```text
get load fetch create update delete validate detect resolve evaluate
build generate handle execute publish summarize
```

## 8. Action Worker only

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
```
