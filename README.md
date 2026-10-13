<div align="center">

# Action Worker

**GitHub 自动化编排与治理控制平面**

任务调度 · AI Agent · PR 治理 · 发布治理 · 部署治理

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-33-1A61FE?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-118-0527FC?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-561-212183?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-9-08872B?style=flat-square)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

<sub>统计口径：Task Dispatch = Handle Task Dispatch 成功次数 · AI Review = AI Review 成功执行次数 · PR Governance = Handle PR Dispatch 成功次数 · Release Governance = Handle Release Dispatch 成功次数</sub>

</div>

---

## Action Worker 是什么

Action Worker 是 Fongap Labs 多个 GitHub 仓库的中央自动化编排与治理控制平面。它统一负责任务调度、AI Agent、PR 治理、CI 证据、发布治理与部署准入；业务仓库只保留产品代码、测试、构建与部署实现。

调用方只声明目标。Action Worker 核实事实、生成执行计划，并依据确定性策略与可验证的证据决定放行或阻断。AI 审查在门禁之后运行，仅提供建议。

```text
任务 / PR
   │
   ▼
Validate（校验）
   ↓
Inspect（检查）
   ↓
Plan（计划）
   ↓
Evidence（证据）
   ↓
Triage（分诊）
   ↓
Review（审查）
   ↓
Gate（门禁）
```

Action Worker 不维护按仓库名区分的分支，也不引入 `projects/`、`adapters/` 或 `profiles/` 目录。

## 核心设计

### 确定性治理 × AI Agent

固定边界与动态判断分离。

**确定性治理**由脚本、合同与策略强制执行：

- 输入合同与调用方身份；
- PR 标题与 CHANGELOG 合同；
- 命名规则；
- 密钥与执行权限；
- Release 的 SemVer、标签与回滚；
- 最终门禁。

**Agent 审查**负责：

- 理解差异与上下文；
- 评估代码、架构、安全、工作流与发布风险；
- 选择审查角色与模型；
- 复核执行结果。

Agent 可以判断风险，但不能重新定义权限边界或门禁。

## 能力

| 能力 | 用途 |
|---|---|
| **Task Dispatch** | 通过固定事件、载荷与提交 SHA 分发可信任务；跨仓库产出经过中央发布门禁 |
| **PR Policy** | 识别差异范围、变更区域与风险，生成执行计划 |
| **AI Triage** | 使用 `Code-Air` 做简短的结构化语义分诊；只能跳过风险极低的审查，或提高审查强度 |
| **AI Review** | 按风险选择 `code / workflow / security / architecture / release` 审查角色 |
| **Agent Skills** | 提供统一的执行纪律，以及缺陷修复、CI 诊断、影响分析、PR 审查和发布验证等任务技能 |
| **CI Evidence** | 通过 `ci.yml → validate-merge`，从目标仓库当前 head SHA 读取执行证据 |
| **Source Policy** | 强制目标提交、默认 HEAD 与 CI 成功准入 |
| **Gate** | 确定性策略与 CI Evidence 决定放行或阻断；AI Review 在门禁通过后异步运行，仅供参考 |
| **Release** | 集中管理 SemVer、标签、发布、产物复验与回滚 |
| **Deploy** | 集中管理部署提交准入；部署实现与生产密钥保留在产品仓库 |

常规的代码、工作流与发布变更，首先由 `Code-Air` 做简短的结构化 AI Triage。若分诊失败或返回结果无效，确定性计划保持不变。只有风险很低的 `code` 变更，才能在高置信度下跳过完整审查；安全、架构与深度风险变更只能提高审查强度。

AI Review 通过版本已固定的 [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) CLI 集中运行。Triage 与 Review 共享一个全局 FIFO 队列。Action Worker 不重试整轮审查：请求级重试由 OpenCodeReview 处理，模型族、供应商、密钥、协议与节点的回退则交给 AI Gateway。

## 快速开始

### 1. PR 治理

受管仓库只保留一个薄的 `dispatch-pr-governance.yml` 触发器。它不执行任何治理逻辑，也不接触 AI Gateway 密钥，只把最小化的 PR 任务发送给 Action Worker。

已批准的完整模板位于 [`templates/pr-dispatcher/dispatch-pr-governance.yml`](templates/pr-dispatcher/dispatch-pr-governance.yml)，必须与该文件逐字节一致。它的要点是：

- 触发事件为 `pull_request_target`，类型为 `opened` 与 `synchronize`；
- 通过 `concurrency` 按 PR 编号取消旧的分发；
- `permissions` 仅为 `statuses: write`；
- 跳过 Dependabot 的 PR（它无法读取 Actions 密钥，由中央 Intake 处理）；
- `runs-on` 通过 `AW_DISPATCH_RUNS_ON` 变量从中央解析；
- 分发前把 `PR Governance` 状态写为 `pending`，分发失败时写为 `failure`；并通过 `AW_DISPATCH_TOKEN` 发送 `run-pr-governance` 事件。

受管仓库只需要 `AW_DISPATCH_TOKEN`，且权限仅限于在同一组织内向 `action-worker` 发送 `repository_dispatch`。目标仓库由 `GITHUB_REPOSITORY_OWNER` 推导。`AI_GATEWAY_URL`、`AIG_ACCESS_KEY_AGENT` 与跨仓库写回凭据只保留在 Action Worker 中。

所有 AI Agent 的运行配置都集中在仓库变量 `AW_AI_AGENT_CONFIG` 中：

```json
{
  "schema_version": 1,
  "agents": {
    "triage": { "enabled": true, "model": "Code-Air" },
    "review": {
      "enabled": false,
      "model": "Code-Pro",
      "routes": {
        "release": { "model": "Code-Max" },
        "security": { "model": "Code-Ultra" },
        "architecture": { "model": "Code-Ultra" },
        "deep": { "model": "Code-Ultra" }
      }
    },
    "writing": { "enabled": true, "model": "Pro" }
  }
}
```

未配置的可选 Agent 保持关闭。当前推荐基线保持 `review.enabled=false`，直到确定性治理独立稳定。Writing、Review 与未来的 Agent 可以独立启用，无需为每个 Agent 维护单独的开关变量。

仓库能力由单一仓库变量 `AW_REPOSITORY_POLICY` 管理。每个仓库只注册一次，并只获得其所需的能力：`pr`、`task`、`release-source`、`release-target` 和/或 `deploy`。

```json
{
  "fongap-labs/ai-gateway": ["pr", "task", "deploy"],
  "fongap-labs/delta": ["pr", "task", "release-source", "release-target"],
  "fongap-labs/external-vault": ["pr", "task", "release-source", "release-target"]
}
```

新增、删除或修改仓库权限，只需修改这个变量，不需要修改 Action Worker 源码。

中央 `AW_CONTROL_TOKEN` 需要 Contents 读写、Pull Requests 读写、Commit Statuses 读写，并在对应的中央能力启用时需要 **Actions 读取**权限。Contents 写入只用于受信任的控制步骤，例如经过校验的依赖修复发布、Release 发布和过期分支的引用清理。`AW_ADMIN_TOKEN` 仅保留给仓库管理用途，例如 Settings、Rulesets 与 SARIF 发布。

中央 PR 流程：

```text
PR 事件
  ↓
repository_dispatch
  ↓
Action Worker
  ↓
Validate → Inspect → Plan → CI Evidence → Gate
  ↓
PR Governance commit status
  ↓ （门禁通过后）
异步 AI Review → 粘性审查摘要
```

Action Worker 会从 GitHub 重新获取 PR 的 base/head SHA、标题、状态与 diff，调用方无法声明这些事实。需要 CI 的变更，会针对当前 head SHA 收集证据。确定性门禁要求 `validate-merge=success`，并在任何 AI Agent 运行之前做出决定；异步 AI Review 只在门禁通过后启动，并且可以读取这些证据。项目测试仍在受管仓库的沙箱中运行，中央控制平面从不执行 PR 提供的代码。

### 2. 任务分发

Action Worker 在执行源仓库自有代码之前，会先物化精确的、不可变的任务源 SHA。检出使用中央 Control 权限，并禁用持久化的 Git 凭据。在运行 `bootstrap.sh` 之前，Control 凭据会被移除，源任务只接收本地的 `AW_SOURCE_DIR` 快照，以及源仓库明确声明的项目密钥。

`AW_EXECUTION_TOKEN` 已被删除，不得配置。源仓库的 bootstrap 代码不再自行 clone 仓库，也不继承 `AW_CONTROL_TOKEN`、`AW_ADMIN_TOKEN`、`AW_DISPATCH_TOKEN` 或 Agent 网关访问密钥。

任务分发只接受一个固定事件：

```text
event_type = run-task
```

载荷只包含：

```json
{
  "schema_version": "1",
  "request_id": "example-001",
  "project": "example",
  "bootstrap_ref": "40-character-commit-sha"
}
```

`bootstrap_ref` 必须是完整的、不可变的提交 SHA。源仓库负责 `.github/task-source.json`、项目任务合同、入口点以及最小的密钥范围；调度与重型执行仍由 Action Worker 负责。

### 3. 发布治理

发布的构建与分发由中央统一编排。源仓库保留项目自有的构建/打包脚本，以及源仓库自有的 `.github/release.manifest.json`。Action Worker 解析不可变的源 SHA，校验 CI 与 provenance，选择抽象的 Runner Profile（运行器配置档），执行声明的构建/打包路径，并产出受治理的发布产物。

```text
不可变源码
  ↓
源仓库自有 .github/release.manifest.json
  ↓
Action Worker 构建 / 打包
  ↓
发布产物 + provenance
  ↓
Release Governance
  ↓
目标仓库发布
  ↓
重新下载校验
  ↓
完成 / 回滚
```

源仓库与目标仓库的权限相互独立：`release-source` 授权构建输入，`release-target` 授权发布目标。业务仓库不持有分发目标的写入凭据。

标签格式为：

```text
<release-key>-v<semver>
```

中央发布器会校验 manifest 与 SHA256 值，发布声明的产物与校验和文件，重新下载进行核对；发布失败时，回滚本次尝试所创建的 release 与标签。

### 4. 部署治理

部署由源仓库声明、由中央执行：

```text
不可变的默认分支源码
  ↓
deploy 能力
  ↓
源仓库自有 .github/deploy.json
  ↓
Central CI
  ↓
同步的 Main Write Audit
  ↓
Runner Resolver
  ↓
通用 source-script 执行器
  ↓
源仓库自有入口点
  ↓
健康检查 / 回滚
```

manifest 只声明部署意图、抽象的 `runner_profile`、环境以及一个安全的、由源仓库自有的入口点。应用密钥通过 `.github/deploy.secrets.required` / `.github/deploy.secrets.allowed` 明确限定范围；Action Worker 在源入口点运行之前移除所有 Control 凭据。

Cloudflare、Server Edge、SSH、Tailscale、数据库迁移、健康检查与回滚逻辑由源仓库负责。重型编排、provenance 校验、特权 Runner 解析、密钥隔离与分发由 Action Worker 负责。自动部署是失败即关闭的：仅在中央 CI 成功、且针对精确源 SHA 的受信任 Main Write Guard 通过之后才运行。

## 变更约定

PR、Agent、CHANGELOG 与 Release 使用相同的类型：

```text
feat / fix / docs / style / refactor / perf
test / build / ci / chore / revert
```

属性：

```text
breaking / security / migration
```

PR 标题格式：

```text
type: summary
type(scope): summary
type!: summary
type(scope)!: summary
```

以下类型默认必须更新 `CHANGELOG.md`：

```text
feat / fix / perf / revert
```

所有破坏性变更也必须更新。完整合同见 [CHANGELOG 约定](docs/CHANGELOG_CONVENTIONS.md)。

## 安全边界

PR 代码始终视为不可信输入。

```text
Control（控制域）
├─ GitHub 元数据
├─ diff
├─ Plan
├─ CI Evidence
├─ 可选 AI Agent
├─ Gate
└─ 允许使用中央密钥

Sandbox（沙箱）
├─ 检出 PR head
├─ build / test / verify
└─ 不接触中央密钥
```

原则：

> 计划可以动态变化；权限边界与门禁必须保持固定。

受管仓库的 CI Runner 作为沙箱执行项目代码。Action Worker 的 Control 只读取 CI Evidence，从不把 AI Gateway 凭据、跨仓库控制凭据或部署密钥传入沙箱。

## 文档

- [文档索引](docs/README.md)：所有治理、架构与指南文档的导航
- [Agent 指南](CLAUDE.md)：Agent 的必读入口与执行边界
- [Agent Skills](skills/README.md)：可复用 Agent 执行技能的权威来源
- [架构](docs/ARCHITECTURE.md)：当前实现与收敛方向
- [架构治理](docs/ARCHITECTURE_GOVERNANCE.md)：长期边界与治理原则
- [命名约定](docs/NAMING_CONVENTIONS.md)：共用命名规则
- [CHANGELOG 约定](docs/CHANGELOG_CONVENTIONS.md)：PR、Agent、CHANGELOG 与 Release 的共用分类
- [开发指南](docs/DEVELOPMENT_GUIDE.md)：通用开发与验证流程
- [接入指南](docs/INTEGRATION_GUIDE.md)：受管仓库的标准接入规范
- [Change Record 合同](contracts/change-record.json)：机器可读的变更合同
- [PR Task 合同](contracts/pr-task.json)：PR Task 输入合同
- [Task Dispatch 合同](contracts/task-dispatch.json)：Task Dispatch 输入合同

## 仓库结构

```text
.github/workflows/   GitHub 入口
docs/                面向人与 Agent 的治理文档
contracts/           机器合同
policies/            确定性治理策略
rules/               AI 审查规则
skills/              可复用 Agent 执行技能
scripts/             共用执行脚本
tests/               治理与合同测试
```

项目专属配置不属于 Action Worker。

## 许可证

[MIT](LICENSE)
