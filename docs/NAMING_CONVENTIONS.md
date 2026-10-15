# 命名约定

> 名称应以最少的必要信息表达完整含义：不依赖隐含上下文，也不重复已经显而易见的信息。

本文件分两层规则：第 1–7 节适用于所有受管的 Fongap Labs 仓库；第 8 节只适用于 Action Worker 本身。业务仓库不得复制本文件，只补充真正属于项目层级的命名约束。

## 1. 命名优先级

命名优先级按以下顺序应用：

1. **脱离上下文仍可识别**：名称脱离其仓库、文件、工作流与调用位置之后，仍应尽可能标明所属系统、用途与类型。
2. **规范词汇**：同一概念使用一个标准词。
3. **无歧义的缩写**：所属系统可以使用清晰、被认可、无歧义的缩写。
4. **最小充分语义**：只保留识别所需的信息；不重复目录、平台或数据本身已经表达的内容。
5. **简洁**：只有在完整含义已经确立之后，才缩短名称。

不要为了凑出固定的段数而删除系统、用途或类型信息，也不要机械地堆砌实现细节来让名称"看起来更完整"。

例如，一个外部密钥：

```text
SERVICE_TOKEN
```

在一个仓库内部可以理解，但在仓库之外无人能判断它属于哪个系统，因此不适合作为新的跨仓库外部名称。

更完整的形式是：

```text
AW_DISPATCH_TOKEN
```

如果某个系统缩写已在本约定或某个项目约定中登记为规范缩写，则可以使用缩写形式。

## 2. 适用范围

### 2.1 外部边界名称

以下名称首先必须在脱离上下文的情况下即可识别：

- GitHub Variables；
- GitHub Secrets；
- 环境变量；
- 工作流的输入与输出；
- 部署参数；
- 跨仓库的载荷字段；
- 对外文档化的配置键。

可以按需组合以下要素：

```text
系统 + 用途 + 类型 + 限定词
```

这不是固定模板，也不要求四个部分都出现。名称一旦能脱离上下文识别，就停止添加词语。

数据表示形式（如 `JSON` 或 `YAML`）只有在以下情况下才进入名称：

- 同一概念同时存在多种表示形式；
- 该表示形式本身是外部合同的一部分；
- 省略该表示形式会造成真正的歧义。

否则，不要把实现格式写进名称。

示例：

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

只有当同一类配置确实存在多个时，才添加限定词，例如 `AIR`、`PRO`、`MAX`。

当运行时名称是从一个规范配置源生成，而不是独立配置时，允许使用运行时派生名称。对于 AI Agent 的模型路由，`AW_AI_AGENT_CONFIG` 是唯一可配置的权威来源；`AW_AI_AGENT_WRITING_MODEL` 与 `AW_AI_AGENT_WRITING_PHARMA_BRIEF_MODEL` 这类名称是生成的运行时环境变量，不得定义为 Repository Variables。

业务仓库可以通过配置所属的目录来标识受限的所有者。对于以下已认可的业务范围下的外部配置：

```text
projects/<owner>/
apps/<owner>/
services/<owner>/
tools/<owner>/
crates/<owner>/
skills/<owner>/
```

标准化后的所有者名称可以作为有效的外部前缀。示例：

```text
projects/MarketBrief/.env.variables → MARKETBRIEF_*
services/server-edge/.env.example → SERVER_EDGE_*
```

这并不允许使用 `ARTIFACT_REPOSITORY` 或 `OUTPUT_DIR` 之类的通用名称；外部名称仍必须携带受限所有者的身份。

### 2.2 本地源码标识符

函数参数、局部变量、私有字段与短生命周期的内部标识符可以依赖其词法上下文，不必重复所属系统的前缀。

例如，在 `ai-gateway` 的请求模块中：

```text
model
request
policy
isEnabled
```

优于：

```text
aiGatewayRequestModel
aiGatewayRequestPolicy
```

本地名称仍必须准确、无歧义，并遵循规范词汇。

## 3. 缩写

允许两类缩写：

### 3.1 行业与平台缩写

广泛认可、无歧义的缩写可以直接使用，例如：

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

### 3.2 项目与系统缩写

Fongap Labs 系统的缩写只有在以下条件全部满足时，才可用于外部配置：

- 已在共用约定或长期有效的项目约定中登记；
- 一个缩写只对应一个系统；
- 不与常见的行业含义冲突；
- 新成员无需依赖某个仓库的上下文，即可查到其定义。

临时发明缩写以缩短名称是禁止的。

如果某个缩写没有稳定的共识，使用完整的系统名称。

当前规范的 Fongap Labs 系统缩写如下：

| 系统 | 缩写 |
|---|---|
| Action Worker | `AW` |
| AI Gateway | `AIG` |
| App Source | `APP_SOURCE` |
| Delta | `DELTA` |
| Server Edge | `SERVER_EDGE` |

项目若新增系统缩写，应先修改此表，再在业务仓库中使用。

## 4. 源码标识符

- Python、Rust 与 TypeScript/TSX 中新增或修改的标识符遵循相同的语义原则；
- 局部函数与参数倾向简短，通常约三个语义段，但完整含义优先；
- 布尔值使用 `is / has / can / should` 语义前缀；
- `impl / helper / common / misc / shared` 作为职责模糊的词禁止使用；`new / final / latest / temp / tmp` 用作工程生命周期标签时，在长期存在的控制平面名称中禁止使用，但在明确定义的领域概念中允许（例如 `temp_access`）；
- 测试、生成代码与第三方代码可以由项目自身的检查器豁免。

"三段"只是局部可读性的偏好，绝不能用来截断外部配置名称。

## 5. 配置类型词

外部配置应尽可能保留表示数据或资源类型的标准词，例如：

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

新的凭据不得使用 `PAT` 作为标准类型词；应使用更通用、更易理解的 `TOKEN` 或 `KEY`，除非第三方平台的原生字段名必须保持不变。

## 6. 工程语言

工程 diff 必须使用英文。工程 diff 指新增或修改的工程内容，包括：

- 标识符；
- 代码注释；
- 工作流名称与步骤；
- 日志与错误信息；
- 测试描述；
- 配置键；
- PR 标题与工程摘要；
- CHANGELOG 条目。

在同一个工程 diff 中混用中英文工程文本是禁止的；新增中文的工程注释、日志、错误信息、测试描述或 CHANGELOG 条目同样禁止。

唯一的例外是：

- 面向用户的界面文案；
- 本地化资源；
- 业务仓库明确以中文维护的文档（Action Worker 本身没有此类文档，见第 8.2 节）。

这些例外永远不适用于 CHANGELOG、PR 标题、代码注释、工作流、日志、错误信息与测试描述；它们始终使用英文。

在 HTML 模板中，标签之间的文本属于面向用户的文案，工程语言检查会与带引号的属性值一并豁免。模板注释（HTML 中的 `<!-- -->`，Hugo 中的 `{{/* */}}`）以及模板中嵌入的日志必须保持英文，并且检查器会把多行注释块的每一行都归属于该注释。

## 7. 文件、术语与动词

- 工作流、控制脚本与测试文件使用 `kebab-case`；
- 治理文档使用 `UPPER_SNAKE_CASE.md`；
- 文件名只表达该文件自身的职责，不重复目录已经提供的上下文；
- 长期存在的名称避免生命周期词与模糊词。

规范术语：

| 概念 | 术语 |
|---|---|
| 机器合同 | `contract` |
| 主变更类别 | `change type` |
| 技术变更区域 | `change area` |
| 快速语义路由 | `triage` |
| 代码审查 | `review` |
| 审查结果 | `finding` |
| 确定性规则 | `policy` |
| 策略例外 | `override` |
| 项目证据 | `context` |
| 模型供应商 | `provider` |
| 路由端点 | `gateway` |
| 工作单元 | `task` |
| 分发 | `dispatch` |
| 状态 | `status` |
| 校验 | `validate / validation` |
| 发布 | `release` |
| Git 标签 | `tag` |
| 持续集成 | `CI` |
| 执行请求 | `execution request` |
| 项目执行声明 | `execution manifest` |
| 通用执行单元 | `executor` |
| 请求的权限 | `capability request` |
| 授予的权限 | `capability grant` |
| 抽象的计算需求 | `runner profile` |
| Runner 选择组件 | `runner resolver` |
| 计算提供方类别 | `runner backend` |

推荐动词：

```text
get load fetch create update delete validate detect resolve evaluate
build generate handle execute publish summarize
```

## 8. 仅适用于 Action Worker

Action Worker 是通用的治理与执行平面。稳定的权威位于：

```text
docs/
contracts/
policies/
rules/
scripts/
tests/
```

平台要求的 `.github/workflows/` 是例外。

当执行框架增长时，如果某些实现层代表可复用的通用能力，并由共用合同驱动，则允许引入与仓库无关的实现层，例如 `executors/`、`runners/` 或 `adapters/`。

Action Worker 不得引入仓库专属的配置结构，例如：

```text
projects/<repository-or-product>/
profiles/<repository-or-product>/
<repository-name>/
```

通用适配器是允许的；实质上是"对仓库 X 做特殊处理"的适配器则不允许。

此限制**不**适用于业务仓库。产品仓库可以合理地使用 `projects/`、`apps/`、`crates/`、`tools/`、`skills/`、`output/` 或其他语义正确的项目专属目录。

Action Worker 的 CI 会强制执行自身的文件名与架构限制。业务仓库可以增加更严格的项目专属命名检查，但不得重新定义共用词汇。

对于统一执行平面，业务仓库使用 `runner_profile` 作为外部合同字段。它们不得把具体的基础设施名称（例如 GitHub Runner 镜像名、`self-hosted` 标签、Runner 组、主机名或云实例名）暴露为项目级配置。`runner profile` 描述需求；`runner resolver` 选择实际的 `runner backend`。

### 8.1 工作流文件名

工作流与 shell 文件名最多包含三个 kebab-case 段（`scripts/validate-naming-rules.ts` 与 `scripts/validate-source-naming.py` 会在每个受管仓库中强制执行）。在此限制之内，`tests/workflow-naming.test.ts` 为 Action Worker 自身的工作流检查以下规则：

- 由 `repository_dispatch` 而非 `push` 启动的工作流，取能放入三段中最完整的名称：`handle-<subject>-dispatch.yml`，然后是 `<subject>-dispatch.yml`，再然后是 `<subject>.yml`。subject 是去掉 `run-` 前缀的事件名。例如：

  ```text
  run-task                 → handle-task-dispatch.yml   （单词 subject：完整形式可以放下）
  run-security-scan        → security-scan-dispatch.yml （两个词：去掉 handle）
  run-source-script-deploy → source-script-deploy.yml   （三个词：只保留 subject；仅作示例，部署工作流按适配器命名，见下文）
  ```

  在能放下的情况下，`handle` 标记接收方；发送方命名为 `dispatch-*`（例如 `scripts/dispatch-central-ci.ts`）。
- 扫描受管仓库并分发工作的对账工作流只有一个：`intake.yml`（显示名 "Intake"）。新增的对账类工作作为它的一个作业加入，不新建 `<subject>-intake.yml`。
- 负责发布或部署的工作流命名为 `release-<kind>.yml` 或 `deploy-<adapter>.yml`，使人能根据想要做的事找到正确的工作流。
  - `<kind>` 说明发布的对象：`app` 是由源仓库构建的应用，`tool` 是从上游镜像而来的第三方工具。
  - `<adapter>` 是 `policies/deploy.json` 中 `adapters` 的一个键（目前为 `source-script`）。
  - 名称中从不包含产品或仓库名。
  - 上面的 dispatch 事件规则不适用于它们。谁可以手动启动它们由 8.3 节的工作流分类决定：`release-app.yml` 与 `deploy-source-script.yml` 是入口，`release-tool.yml` 按计划自动运行。
  - `docs/INTEGRATION_GUIDE.md` 第 12.1 节说明应运行哪一个。该测试检查 kind 与 adapter，因此新增 kind 或 adapter 必须是一次有意的修改。
- 工作流显示名由 `tests/workflow-naming.test.ts` 中的中文映射锁定；例如 `release-app.yml` 对应 `手动 · 发布应用`。
- 保留旧名称的文件会在测试中列出，并写明不值得重命名的原因。目前包括 `handle-pr-dispatch.yml`（`scripts/ci-evidence.ts` 中的 CI Evidence 信任锚点）与 `handle-pr-review.yml`（计入 AI Review 队列）。

### 8.2 文档语言

Action Worker 中供人和 Agent 使用的所有文档，按类型区分语言：

- **机器读取文档使用英文**：`CLAUDE.md`、`AGENTS.md` 与 `skills/`（包括 `skills/README.md`）。
- **面向人的文档使用中文**：`README.md`、`SECURITY.md`、`docs/` 下的治理与指南文档，以及 `docs/proposals/`。每份文档只保留一个中文版本，不保留 `*.zh-CN.md` 或其他语言的镜像文件。
- **例外**：`CHANGELOG.md` 是工程记录，使用英文。

`tests/documentation-language.test.ts` 检查上述规则：机器读取文档不得含有中文，面向人的文档必须含有中文，且仓库中不得存在 `*.zh-CN.md` 文件。

本规则只适用于 Action Worker。业务仓库中工程语言检查对 Markdown 的豁免保持不变；业务仓库的人类阅读文档按 [SHARED_GOVERNANCE.md](SHARED_GOVERNANCE.md) 第 8.2 节使用中文。

### 8.3 工作流分类

Action Worker 的每个工作流恰好属于一个分类，同类工作流使用相同的启动方式与设置。`tests/workflow-classes.test.ts` 列出每个分类的成员并强制执行下表；新增工作流必须先放进其中一类。

| 分类 | 成员 | 可用的触发事件 | Actions 页面上的 Run workflow 按钮 |
|---|---|---|---|
| 入口 | `release-app.yml`、`deploy-source-script.yml`、`task-source-dispatch.yml` | `workflow_dispatch`、`repository_dispatch` | 有，每个输入都有说明 |
| 对账 | `intake.yml` | `push`（main）、`repository_dispatch`（`run-intake`）、`schedule` | 无 |
| 事件处理 | `*-dispatch.yml`、`handle-pr-review.yml`、`cancel-pr-work.yml` | `repository_dispatch` | 无 |
| 维护 | `apply-repository-settings.yml`、`main-write-guard.yml`、`prune-stale-state.yml`、`release-tool.yml`、`update-work-metrics.yml`、`validate-ci.yml` | `push`、`pull_request`、`schedule`、`workflow_run` | 无 |
| 可复用 | `central-ci-sandbox.yml` | `workflow_call` | 无 |

所有分类共同遵守：

- 只有入口工作流可以手动启动。其他工作作为事件的结果自动发生；没有完成的工作由 Intake 在下一轮自动重新发起，不提供手动按钮。
- 工作流级别的 `permissions` 不授予任何写权限；需要写的作业在作业级别声明。
- 每个作业都有 `timeout-minutes`，每个外部 action 都固定到完整的提交 SHA。
- 每个被启动的工作流都声明 `concurrency`（工作流级别，或在必须互斥的作业上）。
- Action Worker 自身不使用 `pull_request_target`，从不在持有中央密钥的环境中运行 PR 代码。

## 9. 简要版本

```text
外部名称 = 脱离仓库上下文仍可识别
使用最小充分语义
系统 + 用途 + 类型 + 限定词 是指导，不是固定模板
除非表示形式属于合同，否则不把 JSON/YAML 编码进名称
语义完整性优先于段数
可识别的缩写允许；临时缩写不允许
本地源码名称可依赖词法上下文
一个概念 = 一个标准术语
布尔值 = is / has / can / should
工程 diff = 英文
CHANGELOG / PR 标题 = 英文
Action Worker 机器读取文档 = 英文；面向人的文档 = 中文（单一文件，无镜像）
纯数据内容文件（.txt / .csv / .tsv）免除语言要求
HTML 模板的文案免除语言要求；模板注释保持英文
```
