# 接入指引

本文档定义业务仓接入 Action Worker 的最小标准。

## 1. 接入目标

普通业务仓接入后，应形成统一链路：

```text
PR
→ Dispatch
→ Action Worker
→ AI Review
→ CI Evidence
→ PR Governance
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
ACTION_WORKER_PAT
```

不得下发：

```text
GATEWAY_ACCESS_KEY_AIR
GH_CONTROL_TOKEN
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

项目自己的 test / build matrix 保留在业务仓，由 `ci-evidence` 聚合所有本地必要检查。

最终 `validate-merge` 不再复制治理逻辑，只调用：

```yaml
uses: fongap-labs/action-worker/.github/actions/validate-merge-policy@main
```

它要求 `ci-evidence=success`；在 Pull Request 上还必须等到当前 head 的 `PR Governance=success`。

## 4. 中央配置

Action Worker Repository Variable：

```text
PR_REPOSITORY_ALLOWLIST
```

加入目标仓库。

Action Worker Secret / Variable：

```text
GH_CONTROL_TOKEN
AI_GATEWAY_URL
GATEWAY_ACCESS_KEY_AIR
REVIEW_ENGINE_REPOSITORY
```

`REVIEW_ENGINE_REPOSITORY` 定义 AI Review Engine 的分发仓库；Review Policy 只保存 engine 名称、版本与资产名，不保存组织或仓库位置。

`GH_CONTROL_TOKEN` 对受管仓至少需要：

- Contents: Read；
- Pull Requests: Read/Write；
- Commit Statuses: Read/Write；
- Actions: Read。

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

业务仓只需要 `ACTION_WORKER_PAT` 来调用 Action Worker，不配置目标仓写 Token。跨仓 Dispatch 目标由业务仓变量 `ACTION_WORKER_REPOSITORY` 提供；若实现支持同组织推导，可将 `${{ github.repository_owner }}/action-worker` 作为无硬编码兜底。

Action Worker 需要：

```text
GH_CONTROL_TOKEN
GH_RELEASE_TOKEN
RELEASE_SOURCE_ALLOWLIST
RELEASE_TARGET_ALLOWLIST
```

`GH_CONTROL_TOKEN` 至少需要读取受管源仓 Contents 与 Actions；`GH_RELEASE_TOKEN` 只授予允许的分发目标 `contents: write`。

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
- 为项目新增独立 AI Review 规则。

如果接入必须这样做，应先判断是不是中央能力缺口，而不是直接加项目特例。

## 8. 接入验收

至少完成一次真实 PR smoke：

- dispatch 成功；
- Action Worker 读取真实 PR；
- AI Review 按 policy 执行或合法跳过；
- CI Evidence 对应当前 head SHA；
- PR Governance 状态回写成功；
- sticky review summary 正常；
- 测试 PR 最终关闭，不合并测试内容。

有 Release 的项目再完成一次非破坏性发布合同验证。
