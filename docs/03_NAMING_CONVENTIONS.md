# 命名约定

> 名称应以最少的必要信息表达完整含义：不依赖隐含上下文，也不重复已经显而易见的信息。

本文件分两层规则：第 1–7 节适用于所有受管的 Fongap Labs 仓库；§2只适用于 Action Worker 本身。业务仓库不得复制本文件，只补充真正属于项目层级的命名约束。

**语言规则**：工程 diff、PR 标题、CHANGELOG、代码注释、工作流、日志、错误信息、测试描述、配置键必须使用英文。详见 `01_SHARED_GOVERNANCE.md` §2。

---

## 1. 命名优先级

按以下顺序应用：

1. **脱离上下文仍可识别**：名称脱离仓库、文件、工作流与调用位置后，仍应尽可能标明所属系统、用途与类型
2. **规范词汇**：同一概念使用一个标准词（见 `TERMINOLOGY.md`）
3. **无歧义的缩写**：所属系统可使用清晰、被认可、无歧义的缩写（见 `TERMINOLOGY.md`）
4. **最小充分语义**：只保留识别所需信息；不重复目录、平台或数据本身已表达的内容
5. **简洁**：只有在完整含义已确立后，才缩短名称

不要为了凑固定段数而删除系统/用途/类型信息，也不要机械堆砌实现细节让名称“看起来更完整”。

示例：外部密钥 `SERVICE_TOKEN` 在仓库内可理解，但仓库外无人知其归属系统。更完整形式：`AW_DISPATCH_TOKEN`。若系统缩写已在 `TERMINOLOGY.md` 登记，可使用缩写。

业务仓库可通过目录标识受限所有者（`projects/<owner>/`、`apps/<owner>/`、`services/<owner>/`、`tools/<owner>/`、`crates/<owner>/`、`skills/<owner>/`）。标准化后的所有者名可作外部前缀，如 `projects/MarketBrief/.env.variables → MARKETBRIEF_*`。这**不允许**使用 `ARTIFACT_REPOSITORY` 或 `OUTPUT_DIR` 等通用名称；外部名称仍必须携带受限所有者身份。

---

## 2. 适用范围

### 2.1 外部边界名称

以下名称必须在脱离上下文时即可识别：

- GitHub Variables
- GitHub Secrets
- 环境变量
- 工作流的输入与输出
- 部署参数
- 跨仓库的载荷字段
- 对外文档化的配置键

可按需组合：`系统 + 用途 + 类型 + 限定词`（非固定模板，不要求四部分全出现；名称一旦可识别即停止添加）。

数据表示形式（`JSON`/`YAML`）仅在以下情况进入名称：
- 同一概念同时存在多种表示形式
- 该表示形式本身是外部合同一部分
- 省略会造成真正歧义

否则不要把实现格式写进名称。

示例：
```
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

仅当同类配置确实存在多个时才添加限定词（如 `AIR`、`PRO`、`MAX`）。

运行时名称从规范配置源生成（而非独立配置）时，允许使用运行时派生名称。AI Agent 模型路由中 `AW_AI_AGENT_CONFIG` 是唯一可配置权威来源；`AW_AI_AGENT_WRITING_MODEL` 等为生成的运行时环境变量，**不得**定义为 Repository Variables。

---

### 2.2 本地源码标识符

函数参数、局部变量、私有字段、短生命周期内部标识符可依赖词法上下文，不必重复系统前缀。

例如 `ai-gateway` 请求模块中：
```
model
request
policy
isEnabled
```
优于：
```
aiGatewayRequestModel
aiGatewayRequestPolicy
```
本地名称仍须准确、无歧义，并遵循规范词汇（`TERMINOLOGY.md`）。

---

## 3. 缩写

允许两类缩写：

### 3.1 行业与平台缩写

广泛认可、无歧义的缩写可直接使用：`API` `URL` `URI` `ID` `CI` `LLM` `HTTP` `HTTPS` `JSON` `YAML` `SQL` `D1` `KV` `GH` `CF` `AWS` `GCP` 等。

### 3.2 项目与系统缩写

Fongap Labs 系统缩写仅在以下条件**全部满足**时可用于外部配置：
- 已在共用约定或长期有效项目约定中登记
- 一缩写对应一系统
- 不与常见行业含义冲突
- 新成员无需依赖某仓库上下文即可查到定义

**临时发明缩写以缩短名称禁止**。无稳定共识时使用完整系统名称。

当前规范的 Fongap Labs 系统缩写（同步自 `TERMINOLOGY.md`）：

| 系统 | 缩写 |
|------|------|
| Action Worker | `AW` |
| AI Gateway | `AIG` |
| App Source | `APP_SOURCE` |
| Delta | `DELTA` |
| Server Edge | `SERVER_EDGE` |

项目新增系统缩写：先修改 `TERMINOLOGY.md` 此表，再在业务仓库使用。

---

## 4. 源码标识符

- Python、Rust、TypeScript/TSX 新增或修改标识符遵循相同语义原则
- 局部函数与参数倾向简短（通常约三语义段），但完整含义优先
- 布尔值用 `is` / `has` / `can` / `should` 语义前缀
- `impl` / `helper` / `common` / `misc` / `shared` 作为职责模糊词**禁止**；`new` / `final` / `latest` / `temp` / `tmp` 用作工程生命周期标签时，在长期控制平面名称中禁止（明确定义的领域概念除外，如 `temp_access`）
- 测试、生成代码、第三方代码可由项目自身检查器豁免

“三段”仅为局部可读性偏好，**绝不能用来截断外部配置名称**。

---

## 5. 配置类型词

外部配置应尽可能保留表示数据/资源类型的标准词（完整表见 `TERMINOLOGY.md`）：

```
TOKEN  KEY  SECRET  ID  URL  URI  PATH  FILE  DIR  JSON  YAML
NAME  REF  SHA  VERSION  TIMEOUT  DELAY  INTERVAL  LIMIT  COUNT
SIZE  BYTES  PORT  HOST  REGION  REPOSITORY  MODE  CONFIG
```

新凭据不得使用 `PAT` 作标准类型词；应用 `TOKEN` 或 `KEY`，除非第三方平台原生字段名必须保持。

---

## 6. 文件、术语与动词

- 工作流、控制脚本、测试文件：`kebab-case`
- 治理文档：`UPPER_SNAKE_CASE.md`
- 文件名只表达自身职责，不重复目录上下文
- 长期名称避免生命周期词与模糊词

**规范术语、推荐动词、系统缩写表**均维护在 `TERMINOLOGY.md`。本文件不再重复，机器文档引用英文键，人类文档引用中文解释。

---

## 7. 仅适用于 Action Worker

Action Worker 是通用治理与执行平面。稳定权威位于：

```
docs/
contracts/
policies/
rules/
scripts/
tests/
```

平台要求的 `.github/workflows/` 为例外。

执行框架增长时，若某实现层代表可复用通用能力并由共用合同驱动，允许引入仓库无关实现层（如 `executors/`、`runners/`、`adapters/`）。

**Action Worker 不得引入仓库专属配置结构**，例如：
```
projects/<repository-or-product>/
profiles/<repository-or-product>/
<repository-name>/
```
通用适配器允许；实质上“对仓库 X 做特殊处理”的适配器不允许。

此限制**不**适用于业务仓库。产品仓库可合理使用 `projects/`、`apps/`、`crates/`、`tools/`、`skills/`、`output/` 等语义正确的项目专属目录。

Action Worker CI 强制执行自身文件名与架构限制。业务仓库可增加更严格的项目专属命名检查，但**不得重新定义共用词汇**。

统一执行平面中，业务仓库使用 `runner_profile` 作为外部合同字段。不得把具体基础设施名称（GitHub Runner 镜像名、`self-hosted` 标签、Runner 组、主机名、云实例名）暴露为项目级配置。`runner profile` 描述需求；`runner resolver` 选择实际 `runner backend`。

---

## 8. 工作流文件名（仅 Action Worker）

工作流与 shell 文件名最多三个 kebab-case 段（`scripts/validate-naming-rules.ts` 与 `scripts/validate-source-naming.py` 在每个受管仓库强制执行）。`tests/workflow-naming.test.ts` 为 Action Worker 自身工作流检查以下规则：

- 由 `repository_dispatch` 启动的工作流，取能放入三段中最完整名称：`handle-<subject>-dispatch.yml` → `<subject>-dispatch.yml` → `<subject>.yml`。subject = 去掉 `run-` 前缀的事件名。
  - `run-task` → `handle-task-dispatch.yml`
  - `run-security-scan` → `security-scan-dispatch.yml`
  - `run-source-script-deploy` → `source-script-deploy.yml`（仅示例，部署工作流按适配器命名，见下）
- 能放下时 `handle` 标记接收方；发送方命名为 `dispatch-*`（如 `scripts/dispatch-central-ci.ts`）
- 对账工作流只有一个：`intake.yml`（显示名 "Intake"）。新增对账类工作作为它的一个作业加入，不新建 `<subject>-intake.yml`
- 发布/部署工作流命名为 `release-<kind>.yml` 或 `deploy-<adapter>.yml`，使人按想做的事找到正确工作流
  - `<kind>`：`app`（源仓库构建应用）、`tool`（上游镜像第三方工具）
  - `<adapter>`：`policies/deploy.json` 中 `adapters` 键（目前为 `source-script`）
  - 名称**从不包含产品或仓库名**
  - 上述 dispatch 事件规则不适用于它们。手动启动权限由 §8.3 工作流分类决定：`release-app.yml` 与 `deploy-source-script.yml` 是入口，`release-tool.yml` 按计划自动运行
- 工作流显示名由 `tests/workflow-naming.test.ts` 中文映射锁定（如 `release-app.yml` 对应 `手动 · 发布应用`）
- 保留旧名称文件在测试中列出并写明不值得重命名原因。目前包括 `handle-pr-dispatch.yml`（CI Evidence 信任锚点）与 `handle-pr-review.yml`（计入 AI Review 队列）

### 8.1 文档语言（仅 Action Worker）

| 文档类型 | 语言 | 备注 |
|----------|------|------|
| 机器读取文档（`CLAUDE.md`、`AGENTS.md`、`skills/` 含 `skills/README.md`） | **英文** | 精确、结构化、可验证 |
| 面向人文档（`README.md`、`SECURITY.md`、`docs/` 治理与指南、`docs/proposals/`） | **中文** | 单一文件，无镜像，先说“是什么” |
| `CHANGELOG.md` | **英文** | 工程记录 |

`tests/documentation-language.test.ts` 检查：机器文档不得含中文、人类文档须含中文、仓库中不得存在 `*.zh-CN.md`。

本规则只适用 Action Worker。业务仓库工程语言检查对 Markdown 的豁免保持不变；业务仓库人类阅读文档按 `01_SHARED_GOVERNANCE.md` §2 使用中文。

### 8.2 工作流分类（仅 Action Worker）

每个工作流恰好属于一个分类，同类共用启动方式与设置。`tests/workflow-classes.test.ts` 列出成员并强制执行：

| 分类 | 成员 | 可用触发事件 | Run workflow 按钮 |
|------|------|--------------|-------------------|
| 入口 | `release-app.yml`、`deploy-source-script.yml`、`task-source-dispatch.yml` | `workflow_dispatch`、`repository_dispatch` | 有，每个输入有说明 |
| 对账 | `intake.yml` | `push`(main)、`repository_dispatch`(`run-intake`)、`schedule` | 无 |
| 事件处理 | `*-dispatch.yml`、`handle-pr-review.yml`、`cancel-pr-work.yml` | `repository_dispatch` | 无 |
| 维护 | `apply-repository-settings.yml`、`main-write-guard.yml`、`prune-stale-state.yml`、`release-tool.yml`、`update-work-metrics.yml`、`validate-ci.yml` | `push`、`pull_request`、`schedule`、`workflow_run` | 无 |
| 可复用 | `central-ci-sandbox.yml` | `workflow_call` | 无 |

所有分类共同遵守：
- 只有入口工作流可手动启动；其他自动发生，未完成工作由 Intake 下一轮重新发起
- 工作流级 `permissions` 不授予写权限；需写的作业在作业级声明
- 每个作业有 `timeout-minutes`，每个外部 action 固定到完整提交 SHA
- 每个被启动工作流声明 `concurrency`（工作流级或必须互斥的作业上）
- Action Worker 自身不使用 `pull_request_target`，从不在持有中央密钥环境中运行 PR 代码