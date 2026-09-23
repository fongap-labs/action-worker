<div align="center">

# Action Worker

**GitHub 自动化编排与治理中枢**

任务调度 · AI Agent · PR 治理 · 发布治理 · 部署治理

<!-- work-metrics:start -->
[![Dispatch](https://img.shields.io/badge/Dispatch-1%2C411-2F80ED?style=flat-square&labelColor=5B5B5B)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-3-8B5CF6?style=flat-square&labelColor=5B5B5B)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-4-6366F1?style=flat-square&labelColor=5B5B5B)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-0-14B8A6?style=flat-square&labelColor=5B5B5B)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status&labelColor=5B5B5B)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

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

Action Worker 使用单一 Repository Variable `AW_REPOSITORY_POLICY` 管理仓库能力。每个仓库只登记一次，可授予 `pr`、`task`、`release-source`、`release-target`：

```json
{
  "fongap-labs/ai-gateway": ["pr", "task"],
  "fongap-labs/delta": ["pr", "task", "release-source"],
  "fongap-labs/external-vault": ["pr", "task", "release-source", "release-target"]
}
```

新增、删除或调整仓库权限只修改该 Variable，不修改 Action Worker 源码。

中央 `AW_CONTROL_TOKEN` 对受管业务仓至少需要 Contents Read、Pull Requests Read/Write、Commit Statuses Read/Write 和 **Actions Read**；Actions Read 用于读取真实 CI Evidence。

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

`AW_EXECUTION_TOKEN` 是 Task 执行读取受管私有仓固定 Commit 的只读凭据（建议仅 `Contents: Read`）。bootstrap 下载完成后，Action Worker 会清除 `AW_EXECUTION_TOKEN`、`AW_CONTROL_TOKEN`、`AW_ADMIN_TOKEN`、`AIG_ACCESS_KEY_AGENT` 与 `AW_DISPATCH_TOKEN`，业务 bootstrap 不继承中央控制凭据。

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

`bootstrap_ref` 必须是完整 Commit SHA；payload 不承载执行逻辑。

### 3. 发布治理

Release 不再由业务仓直接调用中央 reusable workflow。业务仓只负责构建经过自身验证的发布 artifact，并在源构建 Run **完成且成功后**发送最小 Release Task：

```text
Build / Package
  ↓
release artifact
  ├─ release-manifest.json
  └─ release assets
  ↓ workflow_run: completed + success
repository_dispatch: run-release
  ↓
Action Worker
  ↓
Validate Source → Verify CI → Verify Artifact → Validate Target → Publish → Re-download Verify
```

Release Dispatch 合同只包含：

```text
schema_version
request_id
repository
source_sha
source_run_id
artifact_name
```

`release-manifest.json` 定义：

```text
target_repository
release_key
version
release_name
release_notes
prerelease
license { expression, file? }
assets[] { name, sha256 }
```

Action Worker 使用中央 `AW_CONTROL_TOKEN` 读取源仓事实与 Actions artifact，并使用同一凭据写目标分发仓；业务仓不持有目标仓写凭据。Release 来源和目标权限由 `AW_REPOSITORY_POLICY` 中的 `release-source` / `release-target` capability 控制。

Release 默认采用 `Apache-2.0`。每个 App / Release 可以在 manifest 中显式声明其他许可证；如声明 `license.file`，对应许可证文件必须作为 Release asset 一并发布并校验。目标分发仓自己的根 LICENSE 不覆盖各 App 的 Release 许可证。

Tag 统一使用：

```text
<release-key>-v<semver>
```

例如 `agentdock-v0.1.0`。中央发布会先验证 manifest 与 SHA256，创建临时 Draft Release，上传资产及中央生成的 `.sha256` 文件，重新下载复验；任何失败都会回滚本次 Release 与 Tag。

### 4. 部署治理

部署准入统一复用：

```text
validate-deploy-policy.yml@main
  ↓
validate-source-policy.yml
  ↓
业务仓 Deploy
```

默认只允许部署当前默认分支 HEAD。确需部署历史版本时，只接受不可变 40 位 Commit SHA，并仍要求成功 CI。Cloudflare、Server Edge、SSH、Tailscale、数据库迁移、健康检查和回滚实现继续留在业务仓。

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
scripts/             通用执行脚本
tests/               治理与合同测试
```

项目专属配置不进入 Action Worker。

## 许可协议

[MIT](LICENSE)
