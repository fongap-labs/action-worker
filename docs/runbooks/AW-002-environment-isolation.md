# AW-002 环境隔离收尾 Runbook

> 基于提案 AW-002 "使用 GitHub Environments 隔离部署与任务密钥"。部署路径已合并（PR #477），任务路径保持方案 A（仓库级密钥 + 中央上限）。以下为 owner 手动完成步骤。

## 先决条件

- 提案设计已批准（尤其是方案选择：任务路径采用 A）
- 中央策略文件已就位：
  - `policies/deploy-environments.json`：每仓库允许的环境列表
  - `policies/deploy-secrets.json`：每环境允许的密钥名称列表
- `validate-deploy-source.ts` 已接通拒绝名称参数（保留前缀：`AW_`、`GITHUB_`、`RUNNER_`、`ACTIONS_`、`NODE_OPTIONS`、`GH_TOKEN`）
- 检出令牌已替换：`AW_CONTROL_TOKEN` → `AW_CHECKOUT_TOKEN`（只读 Contents: read）
- 所有使用 `AW_ADMIN_TOKEN` 的作业均声明 `environment: admin-ops`

## Owner 手动步骤

### 1. 在环境中创建同名密钥

目标仓库与密钥（来自仓库级 `secrets`）：

| 仓库 | 环境 | 密钥名 |
|------|------|--------|
| ai-gateway | production | 7 个密钥名 |
| internal-vault | server-edge-cloud-edge | 3 个密钥名 |

操作：在 `fongap-labs/action-worker` 的 Settings → Environments → `production` / `admin-ops` / `server-edge-cloud-edge` 中逐个创建，**名称与值完全等同于当前仓库级 secrets**。

### 2. 健康检查演练部署

对每个目标仓库执行一次手动部署：

```bash
# 示例：ai-gateway
gh workflow run release-app.yml -R fongap-labs/action-worker \
  -f source_repository=fongap-labs/ai-gateway \
  -f requested_version=0.0.1-rehearsal \
  -f product=""
```

验证：
- 部署作业成功获得环境密钥（无 "secret not found" 错误）
- `validate-deploy-source` 通过（环境在中央列表中、密钥名在允许列表中）
- 产物上传成功

### 3. 确认 `AW_DEPLOY_SECRET_POLICY_MODE` 与 `AW_TASK_SECRET_POLICY_MODE` 为 `enforce`

两个模式现在**默认就是 `enforce`**：源码里超出中央允许列表的密钥名会直接失败，而不是只告警。仓库变量仍可覆盖，但只有在需要临时放宽时才应改成 `warn`。

在 `fongap-labs/action-worker` 的 Settings → Variables 中确认 `AW_DEPLOY_SECRET_POLICY_MODE` 与 `AW_TASK_SECRET_POLICY_MODE` 均为 `enforce`（或未设置）。

验证：再次触发一次部署与一次任务，确认仍通过（现在任何超出中央列表的密钥名会直接失败）。未在 `policies/deploy-secrets.json` 或 `policies/task-secrets.json` 登记的项目会带着可直接粘贴的策略片段失败。

### 4. 删除仓库级密钥副本

确认演练通过、且 `enforce` 模式下部署仍正常后，在每个目标仓库的 Settings → Secrets 中删除已迁移到环境的密钥。

### 5. 确认 `AW_CHECKOUT_TOKEN` 为只读

检查 `fongap-labs/action-worker` 的 `AW_CHECKOUT_TOKEN`（以及各业务仓库的对应 token）：
- Scopes: `Contents: read`（不含 `Actions: write`、`Secrets: write` 等）
- 用于 `deploy-source-script.yml` 的 `Checkout deploy source` 步骤

## 回滚方案

如演练失败或 `enforce` 导致误拦截：
1. 将 `AW_DEPLOY_SECRET_POLICY_MODE` / `AW_TASK_SECRET_POLICY_MODE` 改回 `warn`（或直接删除该变量——默认已经是 `enforce`，改回 `warn` 才是放宽）
2. 恢复仓库级密钥（已备份值）
3. 部署路径回退至旧行为（中央允许列表仅警告、不拦截）

## 验收标准

- [ ] 所有目标环境密钥已创建且值正确
- [ ] 每个目标仓库至少一次手动部署成功
- [ ] `AW_DEPLOY_SECRET_POLICY_MODE=enforce` 下部署仍通过
- [ ] `AW_TASK_SECRET_POLICY_MODE=enforce` 下任务仍通过
- [ ] 仓库级密钥已删除
- [ ] `AW_CHECKOUT_TOKEN` 仅含 `Contents: read`