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

受 GitHub Ruleset 保护、且要求 `validate-merge` 来自 GitHub Actions 的仓库，再保留一个极轻 `status` 事件入口，调用：

```yaml
uses: fongap-labs/action-worker/.github/workflows/validate-central-merge.yml@main
```

Action Worker 完成 `CI Evidence` 后写入最终 `PR Governance` Commit Status。业务仓在 `PR Governance=success` 时由 GitHub 原生 `status` 事件自动触发，并用本仓 `GITHUB_TOKEN` 为该 SHA 创建 `validate-merge` Check Run。业务仓不复制校验逻辑、不运行产品测试，也不需要中央凭据反向触发。

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

`AW_ADMIN_TOKEN` 只用于仓库设置等管理操作；PR CI 与合并 Gate 不依赖它。需要由 Action Worker 应用受管仓设置时授予：

- Administration: Read/Write。

`validate-merge` Check Run 由目标仓自己的 GitHub Actions `GITHUB_TOKEN` 创建，不需要中央 Token 对目标仓执行 Actions 或 Contents 写操作。

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

Release Governance 区分源码身份与 artifact 执行身份：

```text
source_repository + source_sha
→ build / package
→ artifact_repository + artifact_run_id + artifact_name
→ release-provenance.json
→ release-manifest.json
→ Release Governance
→ target_repository
```

artifact 可以由源仓 Runner 产生，也可以由 Action Worker 中央构建产生；两种模式使用同一合同。中央化后的业务仓只保留项目级 build/package 实现，不保存发布凭据。

Release artifact 根目录必须包含：

```text
release-manifest.json
release-provenance.json
<release assets>
```

`release-provenance.json` 必须精确绑定本次请求：

```json
{
  "schema_version": "1",
  "source_repository": "owner/source-repository",
  "source_sha": "40-character-commit-sha",
  "artifact_repository": "owner/artifact-run-repository",
  "artifact_run_id": 123456
}
```

Release Dispatch 使用 hard-cut v2：

```json
{
  "schema_version": "2",
  "request_id": "release-123456",
  "source_repository": "owner/source-repository",
  "source_sha": "40-character-commit-sha",
  "artifact_repository": "owner/artifact-run-repository",
  "artifact_run_id": 123456,
  "artifact_name": "release-package"
}
```

Action Worker 必须验证：

```text
source repository capability
→ source default HEAD
→ source CI Evidence
→ artifact run identity and success
→ release-provenance.json exact match
→ release-manifest.json
→ declared file set and SHA256
→ target repository capability
→ publish
→ re-download verification
→ finalize or rollback
```

Manifest 继续声明目标仓、版本、许可证和 release assets。许可证属于具体 App / Release；未提供 `license` 时按 `Apache-2.0` 发布，需要其他许可证时由 manifest 显式覆盖。

允许的 Release 源仓与目标仓仍由 `AW_REPOSITORY_POLICY` 的 `release-source` / `release-target` capability 控制。中央构建 artifact 必须来自 Action Worker 自身；迁移期源仓本地 build artifact 只能来自该 source repository 本身。

中央 Tag 固定为：

```text
<release-key>-v<semver>
```

业务仓不得复制 Tag / Release / checksum / rollback 逻辑。

## 6. Release Build

Business repositories keep only a manual thin dispatch and project-owned build script. The dispatch sends the immutable default-branch SHA and optional requested version to Action Worker.

Action Worker owns:

```text
source admission
→ heavy Windows/Linux runner execution
→ artifact aggregation
→ release-manifest.json
→ release-provenance.json
→ Release Governance dispatch
```

The release target comes from `policies/release-build.json`, not a business-repository variable.

## 7. Tool Distribution

Third-party tools are not synchronized by business-repository runners. The distribution repository owns only the catalog and per-tool metadata; Action Worker periodically resolves the registered tool, verifies the upstream stable Release, checksum, optional GitHub digest, and license, then emits a governed Release artifact.

No business repository needs a tool-sync credential or upstream packaging workflow.

## 8. Deploy 接入

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

## 9. 不需要做的事

普通新仓接入不应要求：

- 修改 Action Worker 核心脚本；
- 增加仓库名条件分支；
- 新建 `projects/`、`profiles/`、`adapters/`；
- 为项目复制一份中央 Policy；
- 为项目新增独立 AI Agent 模型变量、Review 开关或项目专属 AI 配置。

如果接入必须这样做，应先判断是不是中央能力缺口，而不是直接加项目特例。

## 10. 接入验收

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
