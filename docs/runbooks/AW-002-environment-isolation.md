# 环境隔离运维手册

## 环境边界

| 环境 | 用途 | 保护要求 |
| --- | --- | --- |
| `production` | AI Gateway、MCP Hub、Internal Vault 中 Server Edge 的正式部署 | 按产品中央密钥白名单，仅注入本次产品所需凭据；不得配置人工审批，以免阻断自动部署 |
| `ai-gateway-ops` | AI Gateway 非敏感部署变量、运行时密钥盘点与更新 | 仅 main；配置必需审批人 |
| `mcp-hub-ops` | MCP Hub 专属运维密钥与变量 | 仅运维用途，不登记 Deployment；审批规则按现有策略 |
| `admin-ops` | Action Worker 管理员操作 | 保持现有策略 |

`ai-gateway-ops` 不是部署目标，不得加入 `policies/deploy-environments.json`，也不得写入 AI Gateway 的 `.github/deploy.json`。

### 管理与生产部署记录隔离

所有引用 `*-ops` 的非部署 Job（包括 `admin-ops`、`ai-gateway-ops`、`mcp-hub-ops`）必须使用：

```yaml
environment:
  name: mcp-hub-ops
  deployment: false
```

该设置仍允许 Job 读取本环境的 Secrets 和 Variables，保留原有的等待及人工审批；不会产生新的 GitHub Deployment 记录。如果 Environment 启用了 GitHub App 自定义部署保护规则，`deployment: false` 不兼容，须先核查规则，不能直接关闭。

实际代码部署继续使用 Action Worker 的 `deploy-source-script.yml` 及目标 `production` Environment；`prepare` 校验部署请求，`deploy` Job 根据中央允许清单绑定单个生产环境，保留 Deployment 审计。现有 `fongap-labs/mcp-hub` 的 `.github/deploy.json` 已声明 `production`。一个 Job 只能绑定一个 GitHub Environment，不能同时继承 `mcp-hub-ops` 与 `production` 的环境级 Secrets；生产凭据必须独立存放于 `production`。不自动复制或迁移机密值。

变更只影响未来的部署对象创建，不会清除已有历史 Deployment。

## 正式部署凭据

Action Worker 中央策略对 `fongap-labs/ai-gateway` 的 `production` 只允许三个声明名称：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AIG_DEPLOY_HEALTH_KEY`

中央别名映射：

| 声明名称 | Action Worker 环境中实际存储名称 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN_SECONDARY` | Worker 代码发布、D1 迁移与绑定 |
| `CLOUDFLARE_ACCOUNT_ID` | `ai-gateway-ops` Variable `CLOUDFLARE_ACCOUNT_ID_SECONDARY` | Cloudflare 账号标识 |

`AIG_DEPLOY_HEALTH_KEY` 是独立随机凭据，直接存储在 Action Worker 的 `production` Environment，并以同名 Cloudflare Worker Secret 保存在运行时。它只允许访问部署健康检查所需的 `/health`、`/v1/models` 与 `/v1/messages/count_tokens`，不属于任何用户访问组，也不能调用模型生成接口。

Provider 凭据、其他访问分组密钥、OAuth 加密密钥、推理/生成中心认证密钥和 Tier 凭据不再属于 `production` 部署密钥范围。

## 创建运维环境

在 `fongap-labs/action-worker` 的 Settings → Environments 中手动创建 `ai-gateway-ops`。

配置：

- Deployment branches：仅允许 `main`。
- Required reviewers：至少一名维护者。
- 不配置绕过审批的自动化规则。

Environment Variables：

| 名称或模式 | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID_SECONDARY` | AI Gateway 所在 Cloudflare 账号 ID（32 位小写十六进制） |
| `AIG_PUBLIC_URL`、`AIG_AFFINITY_KV_ID`、`AIG_USAGE_D1_ID`、`AIG_ANALYTICS_DATASET` | 正式地址及 KV、D1、Analytics 资源标识 |
| `AIG_INFERENCE_TARGET`、`AIG_GENERATION_TARGET` | 私有执行中心的目标 Worker 名称；发布器据此生成 Service Binding |
| `AIG_TIER1_NODES_XX`、`AIG_TIER2_NODES_XX` | 两位分片后缀的节点配置 |
| `AIG_MODELS_CONFIG`、`AIG_POLICIES_CONFIG`、`AIG_ACCESS_MODELS_<GROUP>` | 模型目录、策略和访问组映射；具体模型名仅存在于配置值中 |
| 其余当前源码使用的非敏感 `AIG_*` | 超时、限流、日志、协议回退、用量和功能开关等运行参数 |

以上 AI Gateway Variables 不得同时存在于 Repository、Organization 或 `production` Environment。部署门禁拒绝任何可见重复来源，不采用相同值覆盖或仓库级回退。`AIG_BUILD_SHA`、`AIG_INFERENCE_ACTIVE`、`AIG_GENERATION_ACTIVE`、`AIG_INFERENCE_SERVICE`、`AIG_GENERATION_SERVICE` 由发布过程生成，不得手工配置；旧 Tier 3、OAuth 和会员订阅变量不得迁入。

Environment Secrets：

| 名称 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN_OPS` | 单独创建的 Cloudflare 运维令牌；只授予管理 AI Gateway Worker Secrets 所需权限，并限制到对应账号/资源 |
| `AIG_DEPLOY_HEALTH_KEY` | 独立健康检查密钥。与 Cloudflare Worker 同名 Secret 一致，不得复用任何访问组密钥 |
| `AIG_OPS_SECRET_VALUE` | 单次更新使用的临时密钥值；每次更新前设置，成功后立即删除或替换 |

`CLOUDFLARE_API_TOKEN_OPS` 不得复用 `CLOUDFLARE_API_TOKEN_SECONDARY`。不得将密钥值放进 workflow_dispatch 输入、命令参数、日志或产物。

在 Action Worker 的 `production` Environment 中直接设置 `AIG_DEPLOY_HEALTH_KEY`，其值必须与 Cloudflare Worker Secret 同名值一致。它不是别名，不得复用 `AIG_ACCESS_KEY_AGENT` 或其他用户访问组密钥。

生成独立凭据（在维护者本机终端执行；不要把输出粘贴到聊天、Issue、PR 或日志）：

```bash
openssl rand -hex 32
```

将同一个 64 位十六进制值分别保存到 Action Worker 的 `production`、`ai-gateway-ops` Environment Secret `AIG_DEPLOY_HEALTH_KEY`，以及 Cloudflare Worker Secret `AIG_DEPLOY_HEALTH_KEY`。不得复用 `AIG_ACCESS_KEY_<GROUP>`。


## 首次核验与清理

1. 创建并保护 `ai-gateway-ops`，先完整配置上表 Variables 与所需 Secrets；模型和节点值从现有受控配置原样迁移，不在代码中另建固定模型清单。
2. 运行中央校验并确认变量快照通过后，从 Repository、Organization 和 `production` Environment 删除同名 AI Gateway Variables。删除前不得触发生产部署；未清理的可见重复来源会被部署门禁拒绝。
3. 运行 Cloudflare 密钥盘点：

```bash
gh workflow run ai-gateway-ops.yml \
  -R fongap-labs/action-worker \
  -f operation=inventory
```

4. 核对输出仅包含密钥名称。必须存在：
   - `AIG_DEPLOY_HEALTH_KEY`
   - 至少一个 `AIG_ACCESS_KEY_<GROUP>`
   - 至少一个当前启用 Tier 的 `AIG_TIER[12]_CREDENTIALS_XX`
   - 启用推理/生成中心绑定时对应的 `AIG_INFERENCE_AUTH_KEY` / `AIG_GENERATION_AUTH_KEY`
5. 如缺少密钥，先按下一节逐个补齐；未通过盘点前不得删除 GitHub 中的旧密钥副本。
6. 盘点通过后，在 Action Worker 的 `production` Environment 与仓库级 Secrets 中删除已迁入 Cloudflare 的运行时密钥：
   - `AIG_INFERENCE_AUTH_KEY`
   - `AIG_GENERATION_AUTH_KEY`
   - `AIG_ACCESS_KEY_AIR`、`AIG_ACCESS_KEY_PRO`、`AIG_ACCESS_KEY_MAX`、`AIG_ACCESS_KEY_ULTRA`、`AIG_ACCESS_KEY_AGENT`
   - `AIG_TIER1_CREDENTIALS_XX`、`AIG_TIER2_CREDENTIALS_XX`
7. 保留独立的 `AIG_DEPLOY_HEALTH_KEY`，并确认 Action Worker `production` 与 Cloudflare Worker 中的值完全一致；所有 `AIG_ACCESS_KEY_<GROUP>` 均只保留在 Cloudflare Worker Secrets。
8. 确认 `production` 只保留部署所需 Cloudflare 凭据与健康检查凭据后，经独立生产批准手动触发一次 AI Gateway 部署，确认中央策略、远端密钥盘点和精确 SHA 健康检查全部通过。

## 单项运行时密钥更新

执行入口在 `fongap-labs/action-worker` 的 `ai-gateway-ops` Environment，必须先启用 `main` 分支保护和必需审批人。工作流使用 Cloudflare 官方 Workers Secrets API 的 `GET` 和 `PUT`，绝不创建临时占位 Worker 代码；不使用 `wrangler secret put`，不进行整包 Secret 部署。

先在 `ai-gateway-ops` Environment 中将待更新的值设置为 `AIG_OPS_SECRET_VALUE`，再启动：

```bash
gh workflow run ai-gateway-ops.yml \
  -R fongap-labs/action-worker \
  -f operation=put \
  -f secret_name=AIG_TIER1_CREDENTIALS_01
```

- 工作流只允许更新 AI Gateway 的固定运行时密钥名称集合。
- 值仅存在于受保护 Job 的环境变量与当前 Node 进程内存；直接通过 Cloudflare Workers Secrets API 的 JSON 请求体写入指定 Worker，不以命令参数、日志或产物传递。
- 更新前、后使用 Cloudflare API 盘点 Secret 名称；更新后验证 `/health`，失败即失败关闭，不宣称自动回滚 Secret 值。操作可能已经改变线上密钥，必须由维护者从受控密钥库恢复。
- 成功后立即删除或替换 Environment Secret `AIG_OPS_SECRET_VALUE`。
- 轮换 `AIG_DEPLOY_HEALTH_KEY` 时：先仅将新值写入 `ai-gateway-ops` 的临时 `AIG_OPS_SECRET_VALUE`，执行审批后的 `put`（脚本会用新值进行健康验证）；确认成功后再更新 `production` 和 `ai-gateway-ops` 内的 `AIG_DEPLOY_HEALTH_KEY`；删除临时值。未验证成功时不得提前切换生产健康检查凭据。

## 正常代码部署

AI Gateway 的普通代码部署：

- 只从 `production` 读取 Cloudflare 发布凭据与健康检查凭据。
- 所有 AI Gateway 非敏感部署 Variables 只从受保护的 `ai-gateway-ops` 快照读取；其他作用域出现同名配置即停止。
- 通过 Wrangler 读取 Cloudflare Worker Secret 名称与类型，不读取值。
- 不生成 `gateway-secrets.json`，不传 `--secrets-file`，不重新上传或删除运行时密钥。
- 发现必需密钥缺失时，在发布代码前失败即关闭。
- 部署后按精确源码 SHA 与节点可用状态执行健康检查。

## 其他仓库

- `fongap-labs/internal-vault/server-edge` 正式部署使用 `production`；Server Edge 仍是 Internal Vault 下的独立产品，不能借用 Blog、CDN 的任务密钥。
- Internal Vault 的 Blog、CDN、EngineSuite 等仍通过任务路径执行发布；本次不改变它们的触发器或任务凭据来源。
- 迁移前由维护者将原 `server-edge-cloud-edge` 中 Server Edge 必需的 Variables 与 Secrets 安全迁入 Action Worker 的 `production`；不得仅改策略后立即触发生产部署。GitHub Secrets 原值不可通过 API 回读，迁移须由授权维护者从受控密钥库配置。确认部署成功前不得清理旧环境。
- `fongap-labs/mcp-hub` 继续使用 `production`。
- 本次变更不修改任务路径；任务继续使用现有中央上限与仓库级密钥合同。

## 回滚

- 密钥更新后健康检查失败：工作流失败关闭并保留审计结果。Cloudflare Secret 可能已经更新，不存在可靠的自动密钥值回滚；维护者必须从受控密钥库取回旧值，再通过审批后的 `put` 操作恢复。
- 正常代码部署失败：由 AI Gateway 部署入口回滚 Worker 版本；D1 迁移不随 Worker 回滚自动撤销。
- 不得以删除中央 allowlist、关闭 fail-closed 或增加 Token 自动回退作为修复手段。
