# AI Gateway：Cloudflare 凭据迁移到 Action Worker 仓库

此文档只描述 **fongap-labs/ai-gateway** 在 Action Worker 控制仓库的部署来源。只允许经中央 CI 认可的生产发布修改四个 Cloudflare Worker。

## 目标来源

在 `fongap-labs/action-worker` 的 **Settings → Secrets and variables → Actions** 中配置：

| GitHub 范围 | 名称 | 用途 |
|---|---|---|
| Repository Secrets | `AW_CLOUDFLARE_API_TOKEN_SECONDARY` | Cloudflare API 发布和只读盘点 |
| Repository Secrets | `AW_AIG_INFERENCE_AUTH_KEY` | Gateway ↔ Inference Center 认证 |
| Repository Secrets | `AW_AIG_PERCEPTION_AUTH_KEY` | Gateway ↔ Perception Center 认证 |
| Repository Secrets | `AW_AIG_GENERATION_AUTH_KEY` | Gateway ↔ Generation Center 认证 |
| Repository Variables | `AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY` | Cloudflare Account ID |
| Repository Variables | `AIG_PUBLIC_URL`、`AIG_MODELS_CONFIG`、`AIG_POLICIES_CONFIG`、`AIG_TIER1_NODES_01` 等 | 非敏感部署配置、路由与模型清单 |
| Repository Variables | `AIG_AFFINITY_KV_ID`、`AIG_USAGE_D1_ID`、`AIG_ANALYTICS_DATASET`、`AIG_TRACE_HEAD_SAMPLE_RATE` 等 | Cloudflare 资源标识和观测开关 |

必须从 **Repository** 而非 `ai-gateway-ops` GitHub Environment 创建。此前存放在 Environment 的同名配置不得继续作为可信来源。**任何 Token、Credential、Auth Key 均不得存放 Variables，也不得写入代码。** 如曾作为普通 Variable 进入 Actions 日志，应先吊销并重签真实令牌。

`ai-gateway-ops` Environment 暂时仅保留与 Provider 凭据分片（`AIG_TIER1_CREDENTIALS_XX`、`AIG_TIER2_CREDENTIALS_XX`）和一次性运维 Secret 输入有关的受保护值。它仍是部署作业读取 Provider 凭据的授权边界，**但不再提供 Cloudflare API Token、Account ID、私有 Center auth 或任何 `AIG_*` 普通文本配置。**

## 一次性切换

1. 先将四项 Repository Secrets 与所有仍需的非敏感 Repository Variables 配齐。不能通过 GitHub API 读取 Secret 明文，所以必须由有权限的维护者在 GitHub 设置中一次性输入或轮换，不能以自动复制 Environment Secret 的方式实现。
2. Action Worker GitHub App 必须具备本仓库 **Variables: read** 权限。仓库配置验证 Job 使用该 App 的短期、单仓库只读 Token 调用仓库 Variable API，**不绑定任何 GitHub Environment**，不打印变量值，禁止 Token 名称出现在 Variables。缺值/403 一律拒绝，不回退到 ops。
3. 查看两仓库 CI、Repo Secret 范围和完整来源 SHA。首次切换只能经中央发布门禁执行；检查 Gateway、Inference、Perception、Generation 四个 Worker 身份及私有认证，`/health/ready` 的构建 SHA 必须与发布 SHA 一致。测试 Code-Max 真实请求、429 回退和响应头超时行为。
4. **验证新配置成功后**，再从 `ai-gateway-ops` Environment 删除旧 Cloudflare Token、Account ID、三个 Center auth 和已迁至仓库的普通配置，防止后续影子值干扰。删除 GitHub Environment 的旧值不等于删除 Cloudflare Worker 的运行时 Secret；后者必须保留并按独立密钥轮换流程处理。
5. 如新配置不完整或验证失败，停止发布，不从旧 Environment 自动补值、不把 Secret 转成 Variable，也不承诺跨四 Worker 的原子回滚。

## 源码约束

- `gateway_variables` 仅从 Action Worker 仓库 API 读取并校验非敏感配置，不接入 `ai-gateway-ops`。
- 部署 Job 为 AI Gateway 传入的通用 `REPOSITORY_VARS_JSON` 固定为空对象，已批准的 repository snapshot 是唯一 `AIG_*` 文本来源。
- `deploy-secrets.json` 将四项 Cloudflare/Center 密钥映射到唯一的 `AW_*` Repository Secret 名称；旧 Environment 同名 Secret 不能冒充该来源。
- Source Secret 声明仍使用运行时名称 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `AIG_*_AUTH_KEY`，不改 Gateway 实际运行时契约。
