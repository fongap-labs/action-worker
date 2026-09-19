# 命名规范

> 一个概念，一个标准词；一个名称，最多三段。

## 1. 核心规则

```text
对象：Object + Role + Qualifier
动作：Verb + Object + Qualifier
```

规则：

- 最多三段，不要求必须三段；
- 两段能说清，不用三段；
- 一个连字符或下划线分隔词算一段；
- 不用拼词或自造缩写规避段数；
- 标准缩写可作为一段，例如 `PR`、`API`、`URL`、`CI`、`ID`、`LLM`。

源码标识符校验：

- 中央 PR Governance 对本次变更的 Python、Rust、TypeScript/TSX 源码执行统一命名检查；
- 函数和参数遵循“最多三段”原则；
- 布尔参数与变量使用 `is/has/can/should` 语义前缀（Python/Rust 使用下划线形式）；
- 模块名继续禁止 `impl/helper/common/misc/shared/new/final/latest/temp/tmp` 等弱语义或生命周期词；
- 测试代码与生成目录不纳入源码标识符检查。

工程类 diff 的语言统一规则：

- 新增或修改的代码标识符、代码注释、Workflow 名称与步骤、日志、错误信息、测试描述、配置键和工程说明统一使用英文；
- 同一工程 diff 不混用中英文工程术语；
- 用户界面、本地化资源以及明确以中文维护的说明文档不受此限制。

## 2. 目录

普通资源目录统一使用：

```text
单一复数名词 = 一类资源
```

允许的长期资源目录：

```text
docs/
contracts/
policies/
rules/
scripts/
tests/
```

平台强制目录 `.github/workflows/` 属于例外。

禁止为了保存项目差异建立：

```text
projects/
adapters/
profiles/
```

目录负责提供上下文，文件名不重复目录已经表达的信息。

## 3. 文件

Workflow、TypeScript 控制模块、测试文件与必要的 Shell 边界使用 `kebab-case`，最多三段。

推荐：

```text
validate-ci.yml
handle-pr-dispatch.yml
handle-task-dispatch.yml
publish-release.yml

detect-pr-context.ts
publish-pr-review.ts
resolve-pr-plan.ts
set-pr-status.ts
validate-naming-rules.ts

pr-policy.test.ts
ci-contract.test.ts
```

治理文档统一放在 `docs/`，使用 `UPPER_SNAKE_CASE.md`：

```text
ARCHITECTURE_GOVERNANCE.md
CHANGELOG_CONVENTIONS.md
NAMING_CONVENTIONS.md
```

## 4. 标准词

| 概念 | 标准词 |
|---|---|
| 机器合同 | `contract` |
| 变更主分类 | `change type` |
| 技术变更区域 | `change area` |
| 快速分诊 | `triage` |
| 代码审查 | `review` |
| 审查发现 | `finding` |
| 策略 | `policy` |
| 策略覆盖 | `override` |
| 项目上下文 | `context` |
| 模型供应方 | `provider` |
| 路由入口 | `gateway` |
| 工作单元 | `task` |
| 调度 | `dispatch` |
| 状态 | `status` |
| 校验 | `validate` / `validation` |
| 发布 | `release` |
| 标签 | `tag` |
| 持续集成 | `CI` |

## 5. 动词

优先使用准确动词：

```text
get
load
fetch
create
update
delete
validate
detect
resolve
evaluate
build
generate
handle
execute
publish
summarize
```

## 6. 布尔值

使用 `is / has / can / should` 前缀，例如：

```text
isReviewRequired
hasBlockingFindings
canMergePR
```

## 7. CI 约束

CI 自动阻断：

- Workflow / TypeScript 控制模块 / Test 文件不是 kebab-case；
- 文件名超过三段；
- 长期名称包含 `new / final / latest / temp / tmp`；
- 规范文档不符合约定；
- 出现架构治理禁止的顶层项目配置目录。

模糊名称如 `utils / helpers / common / misc / shared` 只警告。

## 8. 最短记忆版

```text
目录：复数资源集合
对象：Object + Role + Qualifier
动作：Verb + Object + Qualifier
最多三段
一个概念 = 一个标准词
项目差异不进入 Action Worker 目录结构
```
