# 提案 AW-009：为 ai-gateway 增加 cloud-host-docker 部署通道

状态：**草案，待评审，未实施**。本提案不改变任何现有部署行为。

## 1. 背景

ai-gateway 采用双部署通道，两者共用 `main` 作为唯一可信源，部署同一个经过 PR 合并的 commit SHA：

- `cloudflare-worker`：现有通道，经 `source-script` 适配器部署到 Cloudflare Workers。
- `cloud-host-docker`：新增通道，部署到运营者自有云主机上的 Docker 容器。Workers 的 CPU 时间额度不足以承担长请求与流式转换的开销，因此该通道承担长期运行的主要负载。

当前部署模型的限制（已对照仓库文件核对）：

1. `policies/deploy.json` 的 `schema_version` 为 2，只注册了 `source-script` 一个适配器。
2. `policies/deploy-environments.json` 中 `fongap-labs/ai-gateway` 只允许 `production`。
3. `policies/deploy-secrets.json` 中 `production` 的白名单只包含 Cloudflare 凭据与应用密钥，没有云主机连接信息。
4. `fongap-labs/ai-gateway/.github/deploy.json` 只有一个目标：`environment: production`，`automatic: true`，入口 `scripts/deploy.sh`。
5. 中央手动部署只接受当前 `main` 的 HEAD SHA，并要求 Main Write Guard 证明。因此无法指定历史 SHA 进行部署或回滚。
6. 「只改文档则跳过」的判断以整个提交为单位，Docker 通道的改动会触发 Cloudflare 通道的部署，反之亦然。

与 AW-006 的关系：AW-006 处理「一个仓库多个产品」的发布与部署清单拆分。本提案的多目标需求与其重叠，**提交评审前必须先核对 AW-006 已实施的字段，本草案不假设其内容**。

## 2. 提议

### 2.1 多目标部署清单

`.github/deploy.json` 允许声明多个目标。每个目标包含：`name`、`adapter`、`environment`、`automatic`、`entrypoint`、`paths`（路径过滤）。

字段名以现有 schema 与 AW-006 为准，本草案不定稿。示意：

```text
targets:
  cloudflare-worker:   adapter=source-script, environment=production,        automatic=true
  cloud-host-docker:   adapter=docker-host,   environment=production-docker, automatic=<待决>
```

### 2.2 新适配器 `docker-host`

部署步骤：

1. 通过 SSH 连接云主机（连接信息来自 `production-docker` environment）。
2. 检出精确 SHA 到部署目录。
3. 执行 `AIG_BUILD_SHA=<SHA> docker compose up -d --build`。
4. 轮询 `/health`，要求返回的 `build` 等于 SHA，且 `status` 不为 `invalid`。
5. 失败时回滚到上一个成功部署的 SHA，并重新执行第 4 步。
6. 写入审计证据：部署 SHA、目标、健康检查结果、回滚结果。

### 2.3 环境与密钥

- `policies/deploy-environments.json`：`fongap-labs/ai-gateway` 增加 `production-docker`。
- `policies/deploy-secrets.json`：`production-docker` 的 allowed 列表包含云主机连接信息（SSH 主机、用户、私钥）以及 `.env` 所需的应用密钥。具体名称待定。
- SSH 私钥只存在于 `production-docker` environment，不进入 `production`。
- `.env` 内容由运营者在主机上维护。Action Worker 只注入 environment 中声明的密钥，不生成 `.env`。

### 2.4 路径过滤

| 目标 | 触发路径 |
| --- | --- |
| `cloud-host-docker` | `Dockerfile`、`.dockerignore`、`compose.yaml`、`docker/**`、`docs/operations/docker-deployment.md`，以及 `src/**`、`package.json` |
| `cloudflare-worker` | `src/**`、`wrangler*.jsonc`、`package.json`、`scripts/deploy.sh` 等 Worker 相关路径 |

- 只改 Docker 专属文件时，只触发 Docker 通道。
- 改动 `src/**` 等共享路径时，两个通道都触发。
- 具体路径列表需要与 `ignore_docs_only` 的现有语义对齐，本草案不定稿。

### 2.5 指定 SHA 的部署与回滚

- 中央部署增加「指定 SHA」能力：允许部署 `main` 历史中的某个 SHA，而不只是当前 HEAD。
- 该 SHA 必须仍是 `main` 的祖先，并且有对应的合并证明（Main Write Guard）。**是否能对历史 SHA 复用现有证明，需要 Action Worker 的审计模型确认，本草案不假设。**
- 回滚 = 部署上一个成功的 SHA。回滚必须经过同一治理路径，不允许在主机上手工检出旧版本。

### 2.6 治理不变

- 只有 `main` 是可信源。
- Main Write Guard、CI Evidence、`validate-merge` 的规则不变。
- 两个通道各自留下独立的审计证据。

## 3. 风险与待决问题

1. **自动部署**：`cloud-host-docker` 是否在 `main` 合并后自动部署？建议先手动触发，稳定后再开自动。
2. **与 AW-006 的重叠**：多目标清单应由 AW-006 统一设计，还是本提案单独引入？需要评审决定。
3. **历史 SHA 的证明**：指定 SHA 部署需要的合并证明如何复用，需要确认。
4. **SSH 私钥的轮换与最小权限**：只允许部署目录的写权限，轮换流程待定。
5. **网络可达性**：`docker-host` 适配器的 runner 需要能访问云主机（VPN 或防火墙白名单），需要确认。
6. **回滚保留**：是否保留上一版镜像标签？建议保留。

## 4. 不在本提案范围

- 不改变 Cloudflare 通道的任何行为。
- 不改变 Main Write Guard 与 PR Gate。
- 不引入 `docker` 或 `worker` 可信分支。

## 5. 验收

1. 在非生产主机完成一次部署、健康检查与回滚演练。
2. 证据包含：部署 SHA、`/health` 的 `build`、回滚后的 `build`。
3. 两个通道对同一 SHA 的部署结果一致。
4. 只改 Docker 专属文件时，`cloudflare-worker` 通道不被触发。
