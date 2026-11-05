# 提案：部署与任务密钥隔离

状态：**中央部署环境与密钥上限已实施**。部署环境由 Action Worker 中央策略授权，目标清单不能自行扩大权限；任务路径继续采用方案 A（仓库级密钥 + 中央上限）。本次补充 AI Gateway 专属运行时密钥隔离：普通部署仅使用 Cloudflare 发布凭据与健康检查凭据，Provider/业务密钥长期保存在 Cloudflare Worker Secrets；受审批的密钥更新通过 `ai-gateway-ops` 工作流执行。

## 中央控制合同

1. `policies/deploy-environments.json` 决定每个源码仓库可使用的部署环境；未登记即拒绝。
2. `policies/deploy-secrets.json` 决定每个源码仓库/环境可暴露的密钥名称；目标声明超出中央上限即失败即关闭。
3. 保留名称拒绝前缀：`AW_`、`GITHUB_`、`RUNNER_`、`ACTIONS_`、`NODE_OPTIONS`、`GH_TOKEN`。
4. 私有源码检出使用只读 `AW_CHECKOUT_TOKEN`；不得用 `AW_CONTROL_TOKEN` 或 `AW_ADMIN_TOKEN` 检出源码。
5. 使用 `AW_ADMIN_TOKEN` 的作业必须绑定受保护的 `admin-ops` Environment。
6. 部署作业由中央工作流执行；`repository_dispatch` 使用默认分支，不允许 PR 分支取得部署环境密钥。

## 运行时密钥边界

AI Gateway 的部署环境与运维环境职责分离：

| 环境 | 允许内容 | 不允许内容 |
| --- | --- | --- |
| `production` | Cloudflare 发布凭据、账号 ID、部署健康检查凭据 | Provider 密钥、用户访问密钥、Tier 凭据、OAuth 加密密钥、中心认证密钥 |
| `ai-gateway-ops` | 受审批的 Cloudflare Worker Secret 盘点与单项更新 | 正常代码发布、自动任务调度、把密钥值写入 workflow_dispatch 输入或日志 |

AI Gateway `production` 的中央密钥上限为三个声明名称：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AIG_DEPLOY_HEALTH_KEY`

`AIG_DEPLOY_HEALTH_KEY` 是独立随机凭据，直接存储在 Action Worker `production` Environment，并以同名 Cloudflare Worker Secret 保存在运行时。它只允许部署健康检查路由，不属于用户访问组，不得复用任何 `AIG_ACCESS_KEY_<GROUP>`。

Provider 凭据、访问分组密钥、Tier 凭据、OAuth 加密密钥及推理/生成中心认证密钥保留在 Cloudflare Worker Secrets。正常代码部署只通过 `wrangler secret list` 读取名称和类型，不读取、重传或删除值；缺少必需密钥时在代码发布前失败。

`ai-gateway-ops` 工作流仅在 main 上手动触发，并绑定 `ai-gateway-ops` Environment。维护者需手动创建该 Environment、设置必需审批人，并配置独立 Cloudflare 运维令牌。密钥更新值通过 Environment Secret `AIG_OPS_SECRET_VALUE` 单次传入标准输入，不得作为工作流输入；更新后检查 Worker 健康；失败即失败关闭，由维护者通过受审批的 `put` 操作恢复受控密钥库中的旧值。

Environment 的实际保护规则无法通过仓库文件自动创建，必须由维护者在 GitHub Settings 中配置。未创建并保护 `ai-gateway-ops` 前，不得运行密钥更新工作流。

## 任务路径

`handle-task-dispatch.yml` 继续采用方案 A：

- 任务仍使用 Action Worker 仓库级密钥。
- `policies/task-secrets.json` 作为中央上限。
- `AW_TASK_SECRET_POLICY_MODE=enforce` 时，超出中央上限即拒绝。
- 不为每个任务仓库创建重复 Environment；暂不改变任务执行合同。

原因：任务来源覆盖面广，按仓库复制环境密钥会增加维护面；按项目拆分 Environment 也无法解决同仓库不同项目间的边界问题。先保留中央上限，避免为隔离而扩大凭据副本。

## 维护者手动步骤

1. 在 Action Worker 中创建并保护 `ai-gateway-ops`：仅 main、至少一名必需审批人。
2. 在 `production` 与 `ai-gateway-ops` Environment 中配置独立且一致的 `AIG_DEPLOY_HEALTH_KEY`；另配置 `CLOUDFLARE_API_TOKEN_OPS`、`CLOUDFLARE_ACCOUNT_ID_OPS`、`AIG_PUBLIC_URL`；`AIG_OPS_SECRET_VALUE` 仅在单项更新前临时设置。
3. 运行 `ai-gateway-ops.yml` 的 `inventory`，核对 Cloudflare Worker 已有运行时密钥名称。
4. 如缺失，逐个使用 `put` 补齐并通过健康检查；成功后删除临时 `AIG_OPS_SECRET_VALUE`。
5. 盘点通过后，从 Action Worker 的 `production` Environment 与仓库级 Secrets 中删除已迁入 Cloudflare 的 AIG 运行时密钥副本，只保留部署合同要求的凭据。
6. 手动触发一次 AI Gateway 部署，确认中央策略、Cloudflare 密钥盘点、精确 SHA 健康检查全部通过。
7. 确认 `AW_CHECKOUT_TOKEN` 仅有目标仓库 `Contents: read` 权限。

## 验收标准

- [ ] AI Gateway `production` 仅暴露三个中央授权名称。
- [ ] Cloudflare Worker 已存在所有当前运行配置所需的 Secret 名称。
- [ ] 普通代码部署不读取或上传运行时 Secret 值。
- [ ] `ai-gateway-ops` 仅允许 main 手动触发，并启用必需审批人。
- [ ] 单项密钥更新不把值写入输入、日志或产物，更新后执行健康检查与失败回滚。
- [ ] AI Gateway 生产 Environment 中不再保留 Provider/Tier/OAuth/中心认证密钥副本。
- [ ] 任务路径仍使用中央上限，未新增按仓库复制的 Environment。
