# 环境隔离运维手册

## 环境边界

| 环境 | 用途 | 保护要求 |
| --- | --- | --- |
| `production` | 正式 Worker 部署 | 仅部署所需凭据；不得配置人工审批，以免阻断自动部署 |
| `ai-gateway-ops` | AI Gateway 运行时密钥盘点与更新 | 仅 main；配置必需审批人 |
| `server-edge-cloud-edge` | Internal Vault 边缘服务部署 | 保持现有策略 |
| `admin-ops` | Action Worker 管理员操作 | 保持现有策略 |

`ai-gateway-ops` 不是部署目标，不得加入 `policies/deploy-environments.json`，也不得写入 AI Gateway 的 `.github/deploy.json`。

## 正式部署凭据

Action Worker 中央策略对 `fongap-labs/ai-gateway` 的 `production` 只允许三个声明名称：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AIG_DEPLOY_HEALTH_KEY`

中央别名映射：

| 声明名称 | Action Worker 环境中实际存储名称 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN_SECONDARY` | Worker 代码发布、D1 迁移与绑定 |
| `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID_SECONDARY` | Cloudflare 账号标识 |

`AIG_DEPLOY_HEALTH_KEY` 是独立随机凭据，直接存储在 Action Worker 的 `production` Environment，并以同名 Cloudflare Worker Secret 保存在运行时。它只允许访问部署健康检查所需的 `/health`、`/v1/models` 与 `/v1/messages/count_tokens`，不属于任何用户访问组，也不能调用模型生成接口。

Provider 凭据、其他访问分组密钥、OAuth 加密密钥、推理/生成中心认证密钥和 Tier 凭据不再属于 `production` 部署密钥范围。

## 创建运维环境

在 `fongap-labs/action-worker` 的 Settings → Environments 中手动创建 `ai-gateway-ops`。

配置：

- Deployment branches：仅允许 `main`。
- Required reviewers：至少一名维护者。
- 不配置绕过审批的自动化规则。

Environment Variables：

| 名称 | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID_OPS` | AI Gateway 所在 Cloudflare 账号 ID（32 位十六进制） |
| `AIG_PUBLIC_URL` | AI Gateway 正式 HTTPS 地址 |

Environment Secrets：

| 名称 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN_OPS` | 单独创建的 Cloudflare 运维令牌；只授予管理 AI Gateway Worker Secrets 所需权限，并限制到对应账号/资源 |
| `AIG_DEPLOY_HEALTH_KEY` | 与 Cloudflare 中 `AIG_ACCESS_KEY_AGENT` 当前值一致，用于密钥更新后的健康检查 |
| `AIG_OPS_SECRET_VALUE` | 单次更新使用的临时密钥值；每次更新前设置，成功后立即删除或替换 |

`CLOUDFLARE_API_TOKEN_OPS` 不得复用 `CLOUDFLARE_API_TOKEN_SECONDARY`。不得将密钥值放进 workflow_dispatch 输入、命令参数、日志或产物。

在 Action Worker 的 `production` Environment 中直接设置 `AIG_DEPLOY_HEALTH_KEY`，其值必须与 Cloudflare Worker Secret 同名值一致。不得使用 `AIG_ACCESS_KEY_AGENT` 作为别名或复用任何用户访问组密钥。

## 首次核验与清理

1. 创建并保护 `ai-gateway-ops`，配置上表变量与 Secrets。
2. 运行 Cloudflare 密钥盘点：

```bash
gh workflow run ai-gateway-ops.yml \
  -R fongap-labs/action-worker \
  -f operation=inventory
```

3. 核对输出仅包含密钥名称。必须存在：
   - `AIG_DEPLOY_HEALTH_KEY`
   - 至少一个 `AIG_ACCESS_KEY_<GROUP>`
   - 至少一个 `AIG_TIER[123]_CREDENTIALS_XX`
   - 启用 OAuth 节点时的 `AIG_TOKEN_ENCRYPTION_KEY`
   - 启用推理/生成中心绑定时对应的 `AIG_INFERENCE_AUTH_KEY` / `AIG_GENERATION_AUTH_KEY`
4. 如缺少密钥，先按下一节逐个补齐；未通过盘点前不得删除 GitHub 中的旧密钥副本。
5. 盘点通过后，在 Action Worker 的 `production` Environment 与仓库级 Secrets 中删除已迁入 Cloudflare 的运行时密钥：
   - `AIG_TOKEN_ENCRYPTION_KEY`
   - `AIG_INFERENCE_AUTH_KEY`
   - `AIG_GENERATION_AUTH_KEY`
   - `AIG_ACCESS_KEY_AIR`、`AIG_ACCESS_KEY_PRO`、`AIG_ACCESS_KEY_MAX`、`AIG_ACCESS_KEY_ULTRA`、`AIG_ACCESS_KEY_AGENT`
   - `AIG_TIER1_CREDENTIALS_01..10`、`AIG_TIER2_CREDENTIALS_01..10`、`AIG_TIER3_CREDENTIALS_01..10`
6. 保留独立的 `AIG_DEPLOY_HEALTH_KEY`，并确认 Action Worker `production` 与 Cloudflare Worker 中的值完全一致；所有 `AIG_ACCESS_KEY_<GROUP>` 均只保留在 Cloudflare Worker Secrets。
7. 确认 `production` 只保留部署所需 Cloudflare 凭据与健康检查凭据后，手动触发一次 AI Gateway 部署，确认中央策略、远端密钥盘点和精确 SHA 健康检查全部通过。

## 单项运行时密钥更新

先在 `ai-gateway-ops` Environment 中将待更新的值设置为 `AIG_OPS_SECRET_VALUE`，再启动：

```bash
gh workflow run ai-gateway-ops.yml \
  -R fongap-labs/action-worker \
  -f operation=put \
  -f secret_name=AIG_TIER1_CREDENTIALS_01
```

- 工作流只允许更新 AI Gateway 的固定运行时密钥名称集合。
- 值通过标准输入交给 Wrangler，不作为参数、日志或产物传递。
- 更新后自动盘点密钥名称并检查 `/health`；健康检查失败即失败关闭，不宣称自动回滚 Secret 值。
- 成功后立即删除或替换 Environment Secret `AIG_OPS_SECRET_VALUE`。
- 轮换 `AIG_DEPLOY_HEALTH_KEY` 时，先将 `production` 与 `ai-gateway-ops` Environment 中的同名 Secret 更新为同一新值，再将 `AIG_OPS_SECRET_VALUE` 临时设为该值并执行 `put`；确认健康检查通过后删除临时值。

## 正常代码部署

AI Gateway 的普通代码部署：

- 只从 `production` 读取 Cloudflare 发布凭据与健康检查凭据。
- 通过 Wrangler 读取 Cloudflare Worker Secret 名称与类型，不读取值。
- 不生成 `gateway-secrets.json`，不传 `--secrets-file`，不重新上传或删除运行时密钥。
- 发现必需密钥缺失时，在发布代码前失败即关闭。
- 部署后按精确源码 SHA 与节点可用状态执行健康检查。

## 其他仓库

- `fongap-labs/internal-vault/server-edge` 继续使用 `server-edge-cloud-edge`。
- `fongap-labs/mcp-hub` 继续使用 `production`。
- 本次变更不修改任务路径；任务继续使用现有中央上限与仓库级密钥合同。

## 回滚

- 密钥更新后健康检查失败：工作流失败关闭并保留审计结果。Cloudflare Worker Secret 不随 Worker 代码版本回滚；维护者必须从受控密钥库取回旧值，再通过审批后的 `put` 操作恢复。
- 正常代码部署失败：由 AI Gateway 部署入口回滚 Worker 版本；D1 迁移不随 Worker 回滚自动撤销。
- 不得以删除中央 allowlist、关闭 fail-closed 或增加 Token 自动回退作为修复手段。
