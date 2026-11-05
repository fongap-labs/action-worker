# 命名约定

> **新增名称强制三段；三段不足时允许第四段。语义完整，不得凑数。**

第 1–6 节适用于全部受管 Fongap Labs 仓库；第 7–8 节仅适用于 Action Worker。业务仓库只补充项目专属约束，不复制共用规则。

本文采用**中文说明、英文模板和英文范例**。语言规范以 `01_SHARED_GOVERNANCE.md` §2 为准。

---

## 1. 核心原则（Core Principles）

1. 新增自有外部配置与普通工程文件，**必须采用三个语义段**。
2. 三段无法准确表达稳定用途、模块或类型时，**允许第四段**；不得增加第五段。
3. **标准平台名称不受强制段数限制，不允许例外登记。**
4. 名称使用 `TERMINOLOGY.md` 的规范词汇及系统缩写，禁止为缩短名称临时造词。
5. 文件名不重复目录信息；局部标识符按上下文简洁命名。
6. 历史协议与配置须先评估引用及兼容性，再逐步迁移；历史不合规名称不能成为新增名称的依据。

---

## 2. 外部配置（External Configuration）

适用于新增 GitHub Variables、Secrets、环境变量及自有公开配置键。

**Standard Pattern**

```text
SYSTEM_PURPOSE_TYPE
AW_STATUS_TOKEN
AW_DISPATCH_TOKEN
AIG_ACCESS_KEY
```

**Extended Pattern**

```text
SYSTEM_MODULE_PURPOSE_TYPE
AW_STATUS_SIGNING_KEY
AIG_USAGE_D1_ID
```

第四段必须承载不可省略的区别；保留 `TOKEN`、`KEY`、`ID`、`CONFIG` 等标准类型词。仅当协议要求、多种表示并存或不标格式会歧义时，使用 `JSON`、`YAML` 等格式词。

**语义段与下划线数量并不等价。** `APP_SOURCE`、`SERVER_EDGE` 等已定义的复合系统前缀各视为一个语义段；维护术语表不等于登记命名例外。

标准平台名称（如 `GITHUB_TOKEN`、`NODE_OPTIONS`）遵循平台要求，不限段数。既有协议字段（如 `request_id`、`source_sha`、`runner_profile`）不得未经版本化迁移而改名；新字段不据此获得豁免。

AI Agent 路由的唯一可配置权威来源仍是 `AW_AI_AGENT_CONFIG`；`AW_AI_AGENT_WRITING_MODEL` 等历史派生运行时变量**不得**作为 Repository Variables。新增复杂项应进入结构化配置，不扩张为五段及以上的新变量。

业务仓库可从 `projects/<owner>/`、`apps/<owner>/`、`services/<owner>/` 等路径取得所有者前缀；外部名称仍须标明归属，不得新增 `ARTIFACT_REPOSITORY`、`OUTPUT_DIR` 等无归属名称。

---

## 3. 文件命名（File Naming）

新增自有工程文件采用三段 `kebab-case`；稳定职责必须细分时允许四段。扩展名不计段数。

```text
action-object-detail.ext
validate-naming-rules.ts
dispatch-central-ci.ts
session-state-manager.ts
```

工作流与 Shell 文件仍受 §8 的**最多三段**现行检查约束；新增文件优先三段。治理文档使用 `UPPER_SNAKE_CASE.md`；现有编号及引用不得为凑段数随意更改。

`package.json`、`Cargo.toml`、`README.md`、`LICENSE`、`Dockerfile` 等标准生态文件名沿用原生约定。第三方和生成文件不作为本规范的自有文件改名。

---

## 4. 源码标识符（Source Identifiers）

函数、参数、局部变量及私有字段遵循语言原生习惯，**不强制三段**。Python/Rust 使用 `snake_case`；TypeScript/TSX 按类别采用 `camelCase` 或 `PascalCase`。

```typescript
const model = request.model;
const isEnabled = policy.isEnabled;
function restoreSessionState() {}
```

布尔值使用 `is` / `has` / `can` / `should` 语义前缀。禁止用 `impl`、`helper`、`common`、`misc`、`shared` 掩盖职责；长期控制平面不使用 `new`、`final`、`latest`、`temp`、`tmp` 等生命周期标签（明确领域术语除外）。

---

## 5. 缩写与迁移（Abbreviations and Migration）

- 行业通用缩写可直接使用；系统缩写唯一来源为 `TERMINOLOGY.md`。
- 新凭据以 `TOKEN` 或 `KEY` 表示类型，不使用 `PAT`（第三方原生字段除外）。
- 历史工作流、密钥、签名证据、部署参数及 API 名称，必须通过引用清查和兼容验证后才能迁移。
- **不设例外登记、豁免清单或人工批准绕过机制。** 历史不合规名称只能纳入迁移，不能据此新增相同模式。

---

## 6. CI 校验边界（CI Validation）

本文件定义**目标规范**；当前 CI 的实现范围必须如实区分：

- `scripts/validate-naming-rules.ts`、`scripts/validate-source-naming.py`：工作流和 Shell 文件当前检查**最多三段**。
- `scripts/validate-config-naming.ts`：当前检查外部系统前缀及部分凭据、布尔值规则，**尚未强制三段／四段**。
- 后续增加段数检查时须解析规范复合前缀、平台原生命名，并区分新增与历史名称；**不得引入任意命名例外登记**或破坏既有 CI 合同。

---

## 7. 仅适用于 Action Worker（Action Worker Only）

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

## 8. 工作流文件名（Workflow Filenames）

现行校验要求工作流与 Shell 文件名最多三个 kebab-case 段；新增文件应优先采用完整的三段式（`scripts/validate-naming-rules.ts` 与 `scripts/validate-source-naming.py` 在每个受管仓库强制执行）。`tests/workflow-naming.test.ts` 为 Action Worker 自身工作流检查以下规则：

- 由 `repository_dispatch` 启动的工作流，取能放入三段中最完整名称：`handle-<subject>-dispatch.yml` → `<subject>-dispatch.yml` → `<subject>.yml`。subject = 去掉 `run-` 前缀的事件名。
  - `run-task` → `handle-task-dispatch.yml`
  - `run-security-scan` → `security-scan-dispatch.yml`
  - `run-source-script-deploy` → `source-script-deploy.yml`（仅示例，部署工作流按适配器命名，见下）
- 能放下时 `handle` 标记接收方；发送方命名为 `dispatch-*`（如 `scripts/dispatch-central-ci.ts`）
- 对账工作流只有一个：`intake.yml`（显示名 `自动 · 总控调度`）。新增对账类工作作为它的一个作业加入，不新建 `<subject>-intake.yml`
- 发布/部署工作流命名为 `release-<kind>.yml` 或 `deploy-<adapter>.yml`，使人按想做的事找到正确工作流
  - `<kind>`：`app`（源仓库构建应用）、`tool`（上游镜像第三方工具）
  - `<adapter>`：`policies/deploy.json` 中 `adapters` 键（目前为 `source-script`）
  - 名称**从不包含产品或仓库名**
  - 上述 dispatch 事件规则不适用于它们。手动启动权限由 §8.2 工作流分类决定：`release-app.yml`、`release-npm.yml` 与 `deploy-source-script.yml` 是入口，`release-tool.yml` 按计划自动运行
- 工作流显示名由 `tests/workflow-naming.test.ts` 中文映射锁定（如 `release-app.yml` 对应 `手动 · 发布应用`）
- 历史文件名（如 `handle-pr-dispatch.yml`、`handle-pr-review.yml`）仍需维持现有事件和证据引用，迁移须单独验证；不得据此新增豁免名称

### 8.1 文档语言（仅 Action Worker）

机器读取文档使用英文；人类阅读文档使用中文；不建立中英镜像。规则以 `01_SHARED_GOVERNANCE.md` §2 为准，由 `tests/documentation-language.test.ts` 检查。

### 8.2 工作流分类（仅 Action Worker）

每个工作流只能属于一个分类；成员及触发规则以 `tests/workflow-classes.test.ts` 为准。

| 分类 | 允许触发 | 手动启动 |
|------|----------|----------|
| 入口 | `workflow_dispatch`、`repository_dispatch` | 允许 |
| 诊断 | `workflow_dispatch` | 允许（只读） |
| 恢复 | `workflow_dispatch` | 允许（仅 `main`，经 `admin-ops` 审批） |
| 对账 | `push`（`main`）、`repository_dispatch`、`schedule` | 禁止 |
| 事件处理 | `repository_dispatch` | 禁止 |
| 维护 | `push`、`pull_request`、`schedule`、`workflow_run` | 禁止 |
| 可复用 | `workflow_call` | 禁止 |

所有工作流遵守最小权限：工作流级不授予写权限；作业有超时、固定 SHA 的外部 Action 和并发边界；禁止 `pull_request_target`，不在持有中央密钥的环境运行 PR 代码。
