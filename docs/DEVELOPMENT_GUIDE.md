# 开发指引

本文档定义 Action Worker 和受管业务仓共用的开发流程。具体规则以机器合同和治理文档为准。

## 1. 开始前

先确认：

1. 变更属于中央治理还是项目实现；
2. 是否已有可复用 Workflow、Script、Policy 或 Contract；
3. 是否会改变安全边界、Gate 或 Release 语义；
4. 是否需要同步合同测试和文档。

原则：

> 能通用的治理能力进入 Action Worker；项目专属实现留在业务仓。

## 2. 中央与业务仓边界

Action Worker 适合承载：

- PR Governance；
- AI Review；
- CI Evidence；
- Gate；
- Source Policy；
- Release Policy；
- GitHub Release Publish；
- Deploy Policy；
- 通用状态回写；
- 通用输入输出合同。

业务仓保留：

- 产品代码；
- 项目测试；
- build / package / deploy 脚本；
- 平台专属工具链；
- 最薄的调度入口。

禁止为单个项目在 Action Worker 增加仓库名分支或项目配置目录。

## 3. 开发流程

```text
Inspect
→ Define Contract
→ Implement
→ Test
→ PR
→ CI
→ AI Review
→ Governance
→ Merge
```

先改合同、Policy 或测试，再改实现，优先保证边界可验证。

## 4. CI 合同

受管业务仓统一提供：

```text
.github/workflows/ci.yml
        ↓
validate-merge
```

`validate-merge` 只负责聚合项目自己的必要检查，不复制中央治理规则。

Action Worker 需要 CI Evidence 时，只相信目标 head SHA 对应的成功 `validate-merge`。

## 5. Workflow 修改

Workflow 变更至少检查：

- permissions 是否最小；
- Secret 是否进入不可信执行域；
- trigger 是否可能被 fork / PR 输入滥用；
- concurrency 是否符合预期；
- reusable workflow 的 caller / callee 权限边界；
- actionlint / 合同测试，以及在存在 Shell 边界时执行 ShellCheck。

TypeScript 控制逻辑使用 Node 24 直接运行，并通过 `npm run typecheck` 与 `npm test` 验证。仓库不保留独立 `.sh` 控制入口；Shell 只允许作为 Workflow 中短小的 Runner glue，或用于下载并启动外部 `bootstrap.sh` 这类明确的执行边界。

### 工作统计自动回写

`update-work-metrics.yml` 的权限边界固定为：

- 跨仓统计读取使用 `CONTROL_TOKEN`；
- Action Worker 本仓创建统计 PR、运行 CI、合并与删除临时分支使用 `github.token`；
- `main` 继续遵守 PR + `validate-merge`，不得通过直接 push 绕过规则。

仓库或组织的 GitHub Actions 策略必须允许 workflow 请求 `contents: write` 与 `pull-requests: write`，并在 **Settings → Actions → General → Workflow permissions** 启用 **Allow GitHub Actions to create and approve pull requests**。若该开关关闭，统计分支可以创建，但创建 PR 会被 GitHub 以 403 拒绝。

## 6. AI 与 Gate

AI 负责判断风险和发现问题，不决定权限边界。

Gate 必须由可验证结果组成，例如：

- 确定性 policy；
- CI Evidence；
- 合法 OCR Review Result；
- Release Policy；
- GitHub 当前事实。

Agent 不得通过重跑、换模型或降低阈值规避不利结果。

## 7. Source / Release / Deploy

Deploy 的 Commit 与 CI 准入继续复用：

```text
validate-source-policy.yml@main
validate-deploy-policy.yml@main
```

Release 采用中央 Dispatch，不再由业务仓直接创建 Tag / Release：

```text
source build
→ upload release artifact
→ source workflow completed successfully
→ thin workflow_run dispatcher
→ run-release
→ handle-release-dispatch.yml
→ publish governed Release
```

发布 artifact 根目录必须包含：

```text
release-manifest.json
<asset files declared by the manifest>
```

Manifest 必须提供目标仓、`release_key`、SemVer 与每个资产的 SHA256。Action Worker 会独立验证源仓默认 HEAD、`ci.yml`、源构建 Run、artifact 内容与哈希，并在目标仓发布：

```text
<release-key>-v<semver>
```

业务仓只持有用于发送 Release Dispatch 的 `ACTION_WORKER_TOKEN`；目标分发仓写凭据只保存在 Action Worker。

中央发布凭据与运行配置：

```text
CONTROL_TOKEN
RELEASE_TOKEN
RELEASE_SOURCE_ALLOWLIST
RELEASE_TARGET_ALLOWLIST
```

发布失败必须回滚本次 Tag 与 Release。

## 8. 完成标准

开发任务结束前确认：

- 没有重复治理实现；
- 没有新增项目特例；
- 合同测试覆盖新边界；
- CI 通过；
- README / docs 与代码一致；
- 旧入口已清理或明确兼容期限。
