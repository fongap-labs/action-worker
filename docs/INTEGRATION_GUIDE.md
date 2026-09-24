# 接入指引

本文档定义业务仓接入 Action Worker 的最小标准。

## 1. 接入目标

普通业务仓接入后，应形成统一链路：

```text
PR
→ Dispatch
→ Action Worker
→ CI Evidence
→ AI Review
→ PR Governance
→ validate-merge
→ Merge
→ Release Policy
→ Build / Package
→ Release Governance
→ Deploy Policy
→ Deploy
```

业务仓不复制中央治理规则。

## 2. PR 接入

业务仓保留：

```text
.github/workflows/dispatch-pr-governance.yml
```

只负责把最小 PR Task 发送给 Action Worker。

业务仓 Secret：

```text
AW_DISPATCH_TOKEN
```

不得下发：

```text
AIG_ACCESS_KEY_AGENT
AW_CONTROL_TOKEN
AW_EXECUTION_TOKEN
```

## 3. CI 接入

业务仓必须有：

```text
.github/workflows/ci.yml
```

并提供两个稳定 Job：

```text
ci-evidence
validate-merge
```

项目自己的 test / build 命令仍由业务仓定义，但重执行可集中到 Action Worker。业务仓只保留薄 Dispatch 入口。

受 GitHub Ruleset 保护、且要求 `validate-merge` 来自 GitHub Actions 的仓库，再保留一个极轻 `repository_dispatch` 入口，调用：

```yaml
uses: fongap-labs/action-worker/.github/workflows/validate-central-merge.yml@main
```

Action Worker 完成 `CI Evidence` 与 `PR Governance` 后反向触发该入口。目标仓自己的 `GITHUB_TOKEN` 为当前 PR HEAD 创建 `validate-merge` Check Run；业务仓不复制校验逻辑，也不运行产品测试。

## 4. 中央配置

Action Worker Repository Variable：

```text
AW_REPOSITORY_POLICY
```

每个仓库只登记一次，并按需要授予 `pr`、`task`、`release-source`、`release-target` capability。例如：

```json
{
  "fongap-labs/ai-gateway": ["pr", "task"],
  "fongap-labs/delta": ["pr", "task", "release-source"],
  "fongap-labs/internal-vault": ["pr", "task", "release-source"],
  "fongap-labs/external-vault": ["pr", "task", "release-target"]
}
```

Action Worker Repository Variable：

```text
AW_AI_AGENT_CONFIG
AI_GATEWAY_URL
```

Action Worker Secret：

```text
AW_ADMIN_TOKEN
AW_CONTROL_TOKEN
AIG_ACCESS_KEY_AGENT
```

`AW_AI_AGENT_CONFIG` 是所有 AI Agent 的统一运行配置，管理 Agent 的 `enabled` 与逻辑模型。当前至少覆盖 Triage、Review 与 Writing；未来新增其他 Agent 时继续扩展该配置，不再增加 Review 专用模型变量或开关变量。

示例：

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
    "writing": {
      "enabled": true,
      "model": "Pro",
      "routes": {
        "market-brief": { "model": "SenseNova" },
        "pharma-brief": { "model": "Pro" }
      }
    }
  }
}
```

Task Dispatch 会把 Repository Variables 提供给下游可信任务，并从 `AW_AI_AGENT_CONFIG` 派生只读运行时模型变量。例如 `writing.market-brief` 会成为 `AW_AI_AGENT_WRITING_MARKET_BRIEF_MODEL`。业务任务只能引用这些派生值，不再声明项目级模型变量。Review Engine 的分发仓库、版本和资产仍由 `policies/review.json` 管理；policy 不再保存模型名称。

`AW_EXECUTION_TOKEN` 仅用于 Task 执行前读取受管私有仓固定 Commit，建议只授予 `Contents: Read`。它不会传给业务 bootstrap；跨仓发布仍由后续中央步骤使用 `AW_CONTROL_TOKEN`。

`AW_CONTROL_TOKEN` 对受管仓至少需要：

- Contents: Read；
- Pull Requests: Read/Write；
- Commit Statuses: Read/Write；
- Actions: Read。

`AW_ADMIN_TOKEN` 只用于仓库管理和中央反向调度。受管仓的轻量 `validate-merge` 入口使用 `repository_dispatch`，因此该凭据至少需要：

- Administration: Read/Write；
- Contents: Read/Write。

它不需要为了此链路授予目标仓 `Actions: Write`。实际 `validate-merge` Check Run 由目标仓自己的 GitHub Actions `GITHUB_TOKEN` 创建。

### Task 产物跨仓发布

需要把 Task 产物写到其他仓库时，业务任务只负责生成并暂存产物，不配置目标仓写 Token。Action Worker 在任务成功后验证 `AW_REPOSITORY_POLICY`，再使用中央 `AW_CONTROL_TOKEN` 发布：

```text
source repository (release-source)
→ run-task
→ stage artifact
→ Action Worker publication gate
→ target repository (release-target)
```

## 5. Release 接入

有正式程序发布的业务仓采用两段式入口。

第一段是源仓自己的 Build workflow，负责构建并上传一个 Release artifact。artifact 根目录必须包含：

```text
release-manifest.json
<release assets>
```

Manifest 示例：

```json
{
  "schema_version": "1",
  "target_repository": "<distribution-repository>",
  "release_key": "agentdock",
  "version": "0.1.0",
  "release_name": "AgentDock 0.1.0",
  "release_notes": "Release notes.",
  "prerelease": false,
  "license": {
    "expression": "Apache-2.0"
  },
  "assets": [
    {
      "name": "agentdock-windows-x64.exe",
      "sha256": "<64-lowercase-hex>"
    }
  ]
}
```

第二段使用独立的薄 `workflow_run` dispatcher。只有源 Build Run 已完成且成功时才发送：

```text
event_type = run-release
```

最小 payload：

```json
{
  "schema_version": "1",
  "request_id": "release-123456",
  "repository": "owner/source-repository",
  "source_sha": "40-character-commit-sha",
  "source_run_id": 123456,
  "artifact_name": "release-package"
}
```

许可证声明属于具体 App / Release，而不是目标分发仓。未提供 `license` 时按 `Apache-2.0` 发布；需要其他许可证时由源仓在 manifest 中显式覆盖。若使用 `license.file`，对应文件必须列入 `assets[]` 并参与 SHA256 校验。

业务仓只需要 `AW_DISPATCH_TOKEN` 来调用 Action Worker，不配置目标仓写 Token。跨仓 Dispatch 目标统一由 `${{ github.repository_owner }}/action-worker` 推导，不再维护重复的目标仓变量。

同一 GitHub Organization 下的受管仓优先复用组织级配置：

```text
Organization Secret
AW_DISPATCH_TOKEN
```

仅向受 Action Worker 治理的仓库开放该 Secret。

发布源仓若共享同一个分发目标，可同样使用组织级 `RELEASE_TARGET_REPOSITORY`；项目专属部署身份（例如 `DEPLOY_REPOSITORY`）继续使用 Repository 级 Variable。

Action Worker 需要 `AW_CONTROL_TOKEN`。允许的 Release 源仓与目标仓由 `AW_REPOSITORY_POLICY` 的 `release-source` / `release-target` capability 控制。

`AW_CONTROL_TOKEN` 至少需要读取受管源仓 Contents 与 Actions，以及对允许的分发目标 `contents: write`。

中央发布 Tag 固定为：

```text
<release-key>-v<semver>
```

业务仓不得复制 Tag / Release / checksum / rollback 逻辑。

## 6. Deploy 接入

有自动或人工部署的项目优先调用：

```yaml
uses: fongap-labs/action-worker/.github/workflows/validate-deploy-policy.yml@main
```

默认：

```yaml
require_default_head: true
```

如果产品确实需要部署历史版本：

```yaml
require_default_head: false
target_sha: <40-character-commit-sha>
```

历史部署仍必须通过指定 CI，不允许使用分支名、Tag 或其他可移动 ref 绕过 Source Gate。

部署实现及其生产 Secret 继续留在业务仓。

## 7. 不需要做的事

普通新仓接入不应要求：

- 修改 Action Worker 核心脚本；
- 增加仓库名条件分支；
- 新建 `projects/`、`profiles/`、`adapters/`；
- 为项目复制一份中央 Policy；
- 为项目新增独立 AI Agent 模型变量、Review 开关或项目专属 AI 配置。

如果接入必须这样做，应先判断是不是中央能力缺口，而不是直接加项目特例。

## 8. 接入验收

至少完成一次真实 PR smoke：

- dispatch 成功；
- Action Worker 读取真实 PR；
- CI Evidence 对应当前 head SHA；
- AI Agent 按 `AW_AI_AGENT_CONFIG` 启用、禁用或路由；关闭 Review 时确定性 Gate 仍可独立通过；
- PR Governance 状态回写成功；
- validate-merge 同时验证本地证据与 PR Governance；
- sticky review summary 正常；
- 测试 PR 最终关闭，不合并测试内容。

有 Release 的项目再完成一次非破坏性发布合同验证。
