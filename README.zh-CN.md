<div align="center">

# Action Worker

[English](README.md) · **简体中文**

**GitHub 自动化编排与治理中枢**

任务调度 · AI Agent · PR 治理 · 发布治理 · 部署治理

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-0-1A61FE?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-57-0527FC?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-187-212183?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-1-08872B?style=flat-square)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

<sub>统计口径：Task Dispatch = Handle Task Dispatch 成功次数 · AI Review = AI Review 成功执行次数 · PR Governance = Handle PR Dispatch 成功次数 · Release Governance = Handle Release Dispatch 成功次数</sub>

</div>

---

## Action Worker 是什么

Action Worker 是面向多仓库的 GitHub 自动化编排与治理中枢。

统一任务调度、AI Agent、PR 治理、CI Evidence、发布治理与部署准入；业务仓只保留产品代码、测试、构建和部署实现。

调用方只指定目标，Action Worker 负责校验事实、生成计划、执行审查，并依据可验证结果放行或阻断。

```text
Task / PR
   │
   ▼
Validate
   ↓
Inspect
   ↓
Plan
   ↓
Evidence
   ↓
Triage
   ↓
Review
   ↓
Gate
```

不按仓库名维护分支逻辑，也不建立 `projects/`、`adapters/` 或 `profiles/`。

## 核心设计

### 确定性治理 × AI Agent

固定边界与动态判断分离。

**确定性治理**

由脚本、合同和 policy 固化：

- 输入合同与调用来源；
- PR 标题与 CHANGELOG 合同；
- 命名规则；
- Secret 与执行权限；
- Review 阻断阈值；
- Release 的 SemVer、Tag 与回滚；
- Gate。

**Agent 审查**

Agent 负责：

- 理解 diff 与上下文；
- 判断代码、架构、安全、Workflow 与 Release 风险；
- 选择审查角色与模型；
- 复核执行结果。

Agent 可以判断，不能改写权限边界或 Gate。

## 主要能力

| 能力 | 作用 |
|---|---|
| **Task Dispatch** | 通过固定事件、payload 与 Commit SHA 调度可信任务；跨仓产物由中央 Publication Gate 发布 |
| **PR Policy** | 识别 diff、变更区域与风险，生成执行计划 |
| **AI Triage** | 使用 `Code-Air` 做一次短、结构化的语义分诊；只允许跳过极低风险审查或向更强审查升级 |
| **AI Review** | 按风险选择 `code / workflow / security / architecture / release` 审查角色 |
| **Agent Skills** | 统一 Agent 执行纪律，并提供 Bug 修复、CI 诊断、影响分析、PR 审查与发布验证 Skill |
| **CI Evidence** | 读取业务仓当前 head SHA 的 `ci.yml → validate-merge` 执行证据 |
| **Source Policy** | 统一目标 Commit、默认 HEAD 与成功 CI 准入 |
| **Gate** | 综合 AI Review、CI Evidence 与确定性策略放行或阻断 |
| **Release** | 统一 SemVer、Tag、Release、资产复验与失败回滚 |
| **Deploy** | 统一部署 Commit 准入；部署实现与生产 Secret 留业务仓 |

普通代码、Workflow 与 Release 变更会先由 `Code-Air` 执行一次短、结构化的 AI Triage。Triage 失败或返回无效结果时直接保留确定性 Plan；只有低风险 `code` 变更在高置信度下允许跳过完整 Review，任何安全、架构或深度风险都只能升级审查强度。

AI Review 由 [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) CLI 在 Action Worker 中央执行，并固定到明确版本。Triage 与 Review 共用全局 FIFO 队列；Action Worker 不做整轮 Review 重试。请求级重试由 OpenCodeReview 负责，模型族、Provider、Key、协议与节点 fallback 统一交给 AI Gateway。

## 快速开始

### 1. PR 治理

业务仓只保留最薄触发器 `dispatch-pr-governance.yml`。它不执行治理逻辑，也不接触 AI Gateway Secret，只把最小 PR Task 发送给 Action Worker：

```yaml
name: 调度 PR 治理

on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited]

permissions: {}

jobs:
  dispatch:
    runs-on: ubuntu-24.04
    steps:
      - name: 触发中央治理
        env:
          AW_DISPATCH_TOKEN: ${{ secrets.AW_DISPATCH_TOKEN }}
          REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REQUEST_ID: pr-${{ github.repository_id }}-${{ github.event.pull_request.number }}-${{ github.run_id }}
        run: |
          payload="$(jq -cn \
            --arg request_id "$REQUEST_ID" \
            --arg repository "$REPOSITORY" \
            --argjson pr_number "$PR_NUMBER" \
            '{event_type:"run-pr-governance",client_payload:{schema_version:"1",request_id:$request_id,repository:$repository,pr_number:$pr_number}}')"

          curl -fsS -X POST \
            -H "Authorization: Bearer $AW_DISPATCH_TOKEN" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            https://api.github.com/repos/${GITHUB_REPOSITORY_OWNER}/action-worker/dispatches \
            -d "$payload"
```

业务仓只需要 `AW_DISPATCH_TOKEN`，其权限只用于向同一组织的 `action-worker` 发送 `repository_dispatch`；目标仓由 `GITHUB_REPOSITORY_OWNER` 推导。`AI_GATEWAY_URL`、`AIG_ACCESS_KEY_AGENT` 与跨仓回写凭据只保存在 Action Worker。

所有 AI Agent 的运行配置统一使用 Repository Variable `AW_AI_AGENT_CONFIG`。例如：

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

未配置时可选 AI Agent 默认关闭。当前建议保持 `review.enabled=false`，先让确定性治理独立稳定运行；Writing、Review 或未来其他 Agent 可以分别调整，不再维护 Review 专用开关。

Action Worker 使用单一 Repository Variable `AW_REPOSITORY_POLICY` 管理仓库能力。每个仓库只登记一次，只授予实际需要的 `pr`、`task`、`release-source`、`release-target` 和/或 `deploy`：

```json
{
  "fongap-labs/ai-gateway": ["pr", "task", "deploy"],
  "fongap-labs/delta": ["pr", "task", "release-source"],
  "fongap-labs/external-vault": ["pr", "task", "release-target"]
}
```

新增、删除或调整仓库权限只修改该 Variable，不修改 Action Worker 源码。

中央 `AW_CONTROL_TOKEN` 在启用相应能力的受管仓上需要 Contents Read/Write、Pull Requests Read/Write、Commit Statuses Read/Write 和 **Actions Read**。Contents Write 只允许可信 Control 步骤使用，例如经过校验的依赖修复回写、Release 发布和 stale branch ref 清理。`AW_ADMIN_TOKEN` 继续只承担 Repository Settings、Rulesets、SARIF 发布等管理权限。

中央执行链路：

```text
PR event
  ↓
repository_dispatch
  ↓
Action Worker
  ↓
Validate → Inspect → Plan → CI Evidence → Optional AI Agents → Gate
  ↓
PR Governance commit status + sticky review summary
```

Action Worker 会重新从 GitHub 获取 PR 的 base/head SHA、标题、状态和 diff；调用方不能声明这些事实。需要 CI 的变更先收集当前 head SHA 的 CI Evidence；启用的 AI Agent 可以读取这些证据辅助判断，最终仍由确定性 Gate 要求 `validate-merge=success`。项目测试仍在业务仓 Sandbox 执行，中央 Control 不执行 PR 提供的代码。

### 2. 任务调度

Action Worker 会先物化精确且不可变的 Task source SHA，再执行 source-owned 代码。中央 checkout 使用 Control authority，且不持久化 Git 凭据。`bootstrap.sh` 执行前会清除中央 Control 凭据，source task 只获得本地 `AW_SOURCE_DIR` 快照以及源仓显式声明的最小项目 Secret scope。

`AW_EXECUTION_TOKEN` 已删除，不再配置。业务 bootstrap 不再自行 clone 仓库，也不会继承 `AW_CONTROL_TOKEN`、`AW_ADMIN_TOKEN`、`AW_DISPATCH_TOKEN` 或 Agent gateway access key。

Task Dispatch 仅接受固定事件：

```text
event_type = run-task
```

payload 仅包含：

```json
{
  "schema_version": "1",
  "request_id": "example-001",
  "project": "example",
  "bootstrap_ref": "40-character-commit-sha"
}
```

`bootstrap_ref` 必须是完整不可变 Commit SHA。源仓拥有 `.github/task-source.json`、project task contract、entrypoint 和最小 Secret scope；调度与重执行继续统一在 Action Worker。

### 3. 发布治理

Release Build 与发布统一由中央编排。源仓只保留项目 build/package 脚本和 source-owned `.github/release.manifest.json`；Action Worker 解析不可变 source SHA、校验 CI 与 provenance、选择抽象 Runner Profile，并执行声明的构建/打包路径，生成受治理的 Release artifact。

```text
immutable source
  ↓
source-owned .github/release.manifest.json
  ↓
Action Worker Build / Package
  ↓
release artifact + provenance
  ↓
Release Governance
  ↓
target publish
  ↓
re-download verification
  ↓
finalize / rollback
```

Source 与 Target authority 分离：`release-source` 授权构建来源，`release-target` 授权发布目标。业务仓不持有分发目标仓写凭据。

Tag 统一使用：

```text
<release-key>-v<semver>
```

中央 Publisher 校验 manifest 与 SHA256，发布声明的资产及 checksum 文件，再重新下载验证；任何失败都会回滚本次创建的 Release / Tag。

### 4. 部署治理

Deploy 由源仓拥有合同、由中央执行：

```text
immutable default-branch source
  ↓
deploy capability
  ↓
source-owned .github/deploy.json
  ↓
Central CI
  ↓
synchronous Main Write Audit
  ↓
Runner Resolver
  ↓
generic source-script executor
  ↓
source-owned entrypoint
  ↓
health verification / rollback
```

Manifest 只声明部署意图、抽象 `runner_profile`、环境和安全的 source-owned entrypoint。应用 Secret 通过 `.github/deploy.secrets.required` / `.github/deploy.secrets.allowed` 显式最小化声明；执行 source entrypoint 前，Action Worker 会剥离 Control 凭据。

Cloudflare、Server Edge、SSH、Tailscale、数据库迁移、健康检查和回滚实现留在源仓；重编排、provenance 校验、privileged Runner 解析、Secret 隔离与 dispatch 统一留在 Action Worker。自动 Deploy fail closed，只有精确 source SHA 同时通过 Central CI 和可信 Main Write Guard 后才允许执行。

## 变更规范

PR、Agent、CHANGELOG 与 Release 使用同一套 Type：

```text
feat / fix / docs / style / refactor / perf
test / build / ci / chore / revert
```

属性：

```text
breaking / security / migration
```

PR 标题：

```text
type: summary
type(scope): summary
type!: summary
type(scope)!: summary
```

默认要求更新 `CHANGELOG.md`：

```text
feat / fix / perf / revert
```

以及所有 breaking 变更。

完整规则见 [CHANGELOG 规范](docs/CHANGELOG_CONVENTIONS.md)。

## 安全边界

PR 代码始终视为不可信输入。

```text
Control
├─ GitHub metadata
├─ diff
├─ Plan
├─ CI Evidence
├─ optional AI Agents
├─ Gate
└─ central secrets allowed

Sandbox
├─ checkout PR head
├─ build / test / verify
└─ no central secrets
```

原则：

> Plan 可动态，权限边界和 Gate 必须固定。

业务仓 CI Runner 作为 Sandbox 执行项目代码；Action Worker Control 只读取 CI Evidence，不向 Sandbox 下发 AI Gateway、跨仓控制或部署凭据。

## 文档索引

- [文档总入口](docs/README.md) — 人类与 Agent 共用文档导航
- [Agent 指引](CLAUDE.md) — Agent 必读入口与执行边界
- [Agent Skills](skills/README.md) — 可复用 Agent 执行 Skill 的权威入口
- [架构](docs/ARCHITECTURE.md) — 当前实现与收敛方向
- [架构治理](docs/ARCHITECTURE_GOVERNANCE.md) — 长期边界与治理原则
- [命名规范](docs/NAMING_CONVENTIONS.md) — 通用命名规则
- [CHANGELOG 规范](docs/CHANGELOG_CONVENTIONS.md) — PR、Agent、CHANGELOG 与 Release 统一分类
- [开发指引](docs/DEVELOPMENT_GUIDE.md) — 通用开发与验证流程
- [接入指引](docs/INTEGRATION_GUIDE.md) — 新业务仓标准接入流程
- [Change Record 合同](contracts/change-record.json) — 机器可读变更合同
- [PR Task 合同](contracts/pr-task.json) — PR Task 输入合同
- [Task Dispatch 合同](contracts/task-dispatch.json) — Task Dispatch 输入合同

## 仓库结构

```text
.github/workflows/   GitHub 入口
docs/                人类与 Agent 共用治理文档
contracts/           机器合同
policies/            确定性策略
rules/               AI 审查规则
skills/              可复用 Agent 执行 Skill
scripts/             通用执行脚本
tests/               治理与合同测试
```

项目专属配置不进入 Action Worker。

## 许可协议

[MIT](LICENSE)
