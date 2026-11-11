# 发布 / 部署运维手册

本文档面向维护者，记录手动操作步骤、常见失败排查、多产品布局、定时部署、跟随型产品等运维细节。接入指南见 `05_INTEGRATION_GUIDE.md`。

---

## 1. 发布 / 部署工作流速查

| 目的 | 工作流 | 手动输入 | 自动触发 |
|------|--------|----------|----------|
| 发布由源仓库构建的应用 | `手动 · 发布应用` (`release-app.yml`) | `source_repository` (owner/name)、`requested_version` (正式版 `X.Y.Z`，beta 版 `X.Y.Z-beta.N`，可留空=自动计算正式版)、`product` (多产品时必填) | `run-release-build` 分发事件 |
| 补发已发布 Release 中的 npm 包 | `手动 · 补发 npm 包` (`release-npm.yml`) | `repository` (owner/name)、`tag` | `run-npm-republish` 分发事件 |
| 发布上游镜像的第三方工具 | `自动 · 工具发布` (`release-tool.yml`) | 无 | 定时，每 6 小时 |
| 部署某个源提交 | `手动 · 部署服务` (`deploy-source-script.yml`) | `source_repository` (owner/name)、`source_sha` (可选，留空=当前 HEAD) | 中央 CI 通过且部署清单声明 push 触发 |

> `手动 · 发布应用`、`手动 · 补发 npm 包`、`手动 · 部署服务`、`手动 · 派发任务` 有 Run workflow 按钮；其余工作流自动运行。

---

## 2. 启动前检查清单

启动 `手动 · 发布应用` 或 `手动 · 部署服务` 前，**无需**手动准备 CI/main-write 证明——工作流会自动申请并等待最多 20 分钟。补发 npm 时只选择 Action Worker 已正式发布的 Release。仅需确认：

1. 目标改动已通过 PR 合并进 `main`
2. `source_repository` 写成 `owner/name`，且该仓库在 `AW_REPOSITORY_POLICY` 中具备对应能力（`release-source` / `deploy`）
3. 发布时 `requested_version` 手动填写：正式版如 `v1.2.3`，beta 版如 `v1.2.3-beta.1`（作为预发布发布）。留空由 Action Worker 按上次正式版之后的 Conventional Commits 自动计算下一个正式版

---

## 3. 常见失败与对策

| 日志报错 | 原因 | 处理 |
|----------|------|------|
| `Invalid repository: x. Enter it as owner/name` | 只写仓库名 | 按提示写成 `owner/name` |
| `Repository is not allowed for <能力>` | 仓库缺少能力 | 报错末尾列出具备该能力的仓库；需新增时修改 `AW_REPOSITORY_POLICY` |
| `Requested release version must be X.Y.Z (formal) or X.Y.Z-beta.N` | 版本不是三段数字，或预发布后缀不是 `-beta.N`（N ≥ 1） | 改成 `v1.2.3` 或 `v1.2.3-beta.1` |
| `No release-worthy Conventional Commits since <base>. Cut a change or enter an explicit requested_version.` | 自动模式下跨度内没有 feat/fix 等可发布提交 | 合并新改动的 PR 后重启，或显式填一个稳定版本 |
| `Commit subjects are not Conventional Commits titles (CHANGELOG_CONVENTIONS.md §3): ...` | 自动模式跨度内混入未按规范书写的提交标题 | 修正提交信息（PR 标题即提交标题），或显式填稳定版本跳过自动计算 |
| `The commit span holds N commits, more than ... accepts. Enter an explicit requested_version instead.` | 自动模式下，距上次正式版积累的提交太多（compare 截断 / 跨度上限 / 产品根过滤上限） | 显式填版本（正式版或 beta 均可）；填了版本就不会再读取提交跨度 |
| `source_sha must be a full 40-character lowercase commit SHA` | SHA 格式错误 | 填完整 SHA，或留空部署当前 HEAD |
| `default HEAD moved` / `must be the current default-branch HEAD` | 启动后默认分支有新提交 | 重新启动工作流 |
| `Source SHA failed CI Evidence: central CI failed for ...` | 中央 CI 失败 | 打开报错链接查看失败 job，通过 PR 修复合并，等 CI 通过后重启 |
| `Source SHA has no successful Action Worker CI Evidence` | 等待 20 分钟 CI 仍无结果 | 在 Actions → `自动 · CI 分发` 找到运行，等通过后重启 |
| `was not produced by a successful Action Worker CI run` | 状态存在但写入 CI 运行未成功 | 打开报错运行查看原因；必要时合并新提交触发 CI 重跑 |
| `Product is required because the source repository has several products.` | 多产品仓库未填 `product` | 填报错列出的产品目录名 |
| `Unknown product: <名称>.` | `product` 非 `projects/` 下目录 | 从报错列表中选择 |
| `Repository has root manifests in .github/ and products under projects/.` | 根清单与 projects 共存 | 只保留一种布局（见 §5） |
| `Release key is declared by more than one product` | 两产品 `release_key` 相同 | 给其中一个改用不同 `release_key` |
| `Product release manifest must declare root` | 缺少 `root` 或 `root` 非法 | 填相对仓库根目录的路径，不以 `/` 开头、不含 `..` |
| `Source SHA has no successful Main Write Guard status` | `main` SHA 未证明来自合法 PR 合并 | 几分钟后重启；仍出现则查看最新 `自动 · 总控调度` → `Main write audit` 作业 |
| `Source SHA failed Main Write Guard` / `not uniquely attributable to a merged pull request` | `main` 有直接 push 等非法提交 | 通过新 PR 合并提交（需通过 `validate-merge`），让 `main` HEAD 回到合法合并 |

**PR 治理常见失败**：

| 日志报错 | 处理 |
|----------|------|
| `PR title must use type(scope)!: summary format` | 改成 `fix(deploy): retry the health check` 格式；报错列出允许类型 |
| `Invalid CHANGELOG entry` / `CHANGELOG uses unsupported category` / `must be Chinese text` | CHANGELOG 写成 `- 修复: 中文摘要`，类别仅为新增、修复、维护，摘要用中文（见 `04_CHANGELOG_CONVENTIONS.md` §5） |
| `Attribution check failed` | 作者/提交者/trailer/署名行出现 AI 名称。改成自己的 GitHub 账号，重写提交，强制推送 |

---

## 4. 发布流程详解

### 当前生产默认：只读变更日志发布

```text
不可变源码 → 中央构建/打包 → release-manifest + provenance
→ Release Governance、来源提交和中央 CI/Main Write Guard 校验
→ 只读目标仓库 CHANGELOG.md，生成版本说明（不创建或合并变更日志 PR）
→ 草稿 Release（未创建正式 tag）→ 上传资产 → SHA256/checksum 校验
→ 发布草稿为正式 Release；此时 tag 指向已验证的目标提交
```

**当前 `handle-release-dispatch.yml` 没有开启两阶段发布**，既不向发布作业注入 `AW_RELEASE_TWO_PHASE_MODE=staging`，也不提供阶段一的目标 PR 写入凭据。默认 `publish-release.ts` 直接读取目标 CHANGELOG；manifest 的非空 `release_notes` 可以优先用作说明，否则由只读 CHANGELOG 生成。没有可发布的变更日志条目时保持原有拒绝语义，提交跨度列表不是 Release 说明的后备来源。

发布的最后一步是 GitHub `PATCH draft=false`：调用**发出之前**发生失败时，才可对确认为本次新建、尚未发布的草稿进行最佳努力清理；如果正式发布请求已发出但响应丢失、超时或失败，**不得自动删除可能已发布的 Release 或 tag**，应由授权维护者核对 Release 状态、tag SHA 与受管目标提交后决定恢复。成功完成资产校验不等于已发布成功。

### 受控非生产试点：两阶段发布（目前禁用）

```text
明确获批的 staging 目标仓库 + 审核过的目标 PR 写入和状态读取凭据
→ 固定不可变来源/产物 SHA 与中央 CI/Main Write Guard 验证
→ CHANGELOG 版本小节 PR（chore(release): <tag>）
→ 签名 validate-merge 与受保护 PR 合并
→ 合并 SHA Main Write Guard + 实际合并版本小节/manifest 条目一致性
→ 以该 merge SHA 创建草稿 Release → 上传和校验资产
→ 受控正式发布 → tag 指向该 merge SHA
```

该源码路径已接线，但 `policies/release-two-phase-staging.json` 的 `approved_staging_repositories` **默认为空**；除非治理 PR 明确批准目标，且受保护 staging 运行环境同时提供独立的目标 `pull-requests:write` 与状态读取凭据，否则一律 fail-closed。生产工作流的权限和行为不因源码存在而变化。

阶段一复用历史 PR 时必须核验 tag/来源仓库/受保护目标、实际合并后的版本号和 manifest 条目及 Main Write Guard；合并后版本小节是 staging Release 说明的权威来源，manifest 若显式提供不同的 `release_notes` 则拒绝。阶段一 PR 合并和 Main Write Guard 共享单次截止时间；staging 源码预算为 12 分钟，**不代表**现有 20 分钟生产作业已有足够时间完成全链路。未获批准的真实非生产 E2E、重试、取消及发布失败回滚验收不得标记成功。详情见 [受控试点手册](release-two-phase-staging.md) 和 [#1495](https://github.com/fongap-labs/action-worker/issues/1495)。

- 业务仓库保留构建/打包脚本，在 `.github/release.manifest.json`（单产品）或 `projects/<产品>/release.manifest.json`（多产品）声明构建目标、产物、`runner_profile`。
- Manifest **不含版本**；版本来自发布请求，留空时由三类提交计算。具体产品仍须符合它自己的显式版本策略。
- 项目构建脚本必填 `-Version` 参数，将版本写入构建产物并校验。

### 4.1 多产品发布

一个仓库含多个软件时，每个软件各自声明发布清单：

```
仓库根目录
├── .github/
│   ├── release.manifest.json      # 单产品用；多产品**不放**此文件
│   └── scripts/release-build.ps1  # 可共用
└── projects/
    ├── web/
    │   └── release.manifest.json  # 产品 web 的发布清单
    └── api/
        └── release.manifest.json  # 产品 api 的发布清单
```

规则：
- 目录名 = 产品名（字母数字 `._-`，1-64 字符，字母数字开头）
- 含 `release.manifest.json`/`deploy.json`/`follows.json` 之一即为产品
- 根清单与 `projects/` 产品**不能同时存在**
- 同一仓库内每个产品 `release_key` 必须不同
- `root`：构建目录相对仓库根（如 `projects/web`），不以 `/` 开头、不含 `..`、非空

启动：`手动 · 发布应用` 的 `product` 输入填产品目录名（如 `web`）；漏填报错列出可选项。不同产品并发组不同，互不排队。

构建脚本读取 `RELEASE_PRODUCT_ROOT`（产品根目录绝对路径）。

---

### 4.2 补发已有版本到包管理仓库

如果 Release Governance 已成功创建 GitHub Release，但 npm 发布因认证配置失败，可从 Actions → `手动 · 补发 npm 包` 重新发布既有产物。输入目标仓库与 Release 标签，例如：

```text
repository: fongap-labs/dsh-plugin
tag: dsh-ui-delta-v0.1.0-beta.2
```

工作流只接受受管策略允许的目标仓库，并校验 Release 的来源、中央 CI、Main Write Guard、tarball SHA256、包名和版本。它会先核对 npm 上的版本完整性；相同内容视为已发布并确保 `beta` / `latest` dist-tag 正确，不同内容则停止，避免覆盖不可变版本。Beta 版本使用 `beta` dist-tag。

### 4.3 业务仓库声明发布矩阵（既有合同）

发布平台、构建脚本和产物由**业务仓库**的 `.github/release.manifest.json`（单产品）或 `projects/<产品>/release.manifest.json`（多产品）声明。Action Worker 只解析 `schema_version: 1` 合同，并将 `builds` 转成中央构建 Matrix；任何项目都不应自行复制中央发布 Workflow。

例如，某个桌面产品按实际需要声明 Windows、Linux 与 macOS 三种构建（示例省略清单的其他必填字段）：

```json
{
  "builds": [
    {"id":"windows-x64","runner_profile":"windows-build","target":"x86_64-pc-windows-msvc","script":"scripts/build.ps1","assets":["app-windows.zip"],"attest_asset":"app-windows.zip"},
    {"id":"linux-x64","runner_profile":"linux-standard","target":"x86_64-unknown-linux-gnu","script":"scripts/build.mjs","assets":["app-linux.tar.gz"],"attest_asset":"app-linux.tar.gz"},
    {"id":"macos-universal","runner_profile":"macos-build","target":"universal-apple-darwin","script":"scripts/build.mjs","assets":["app-macos.dmg"],"attest_asset":"app-macos.dmg"}
  ]
}
```

- `runner_profile` 必须引用中央 `policies/runner.json` 中已启用的 **sandbox** 类型；业务仓库不得直接指定 Runner 标签、凭据或管理权限。
- 每项 `assets` 是完整的预期文件清单，中央打包阶段拒绝缺失、重复和额外文件；并非声明某平台就保证该平台能够成功构建。
- 当 `attest_asset` 非空时，独立可信 Job 对此构建产生的**全部上传文件**生成来源证明；打包阶段逐一执行 `gh attestation verify`，验证主体文件摘要、中央 Workflow 身份和控制仓库源提交 SHA。正式版要求每个构建声明证明对象；旧 beta 继续允许空值跳过，避免破坏旧版试用流程。没有正确 Attestation 的正式版不发布。
- 多平台只按产品需求添加；不要求 AI Gateway、MCP Hub 这样的云服务产品生成桌面安装包。
- 每项 `builds[]` 可选择提供 `acceptance_script`（相对产品根目录的 `.mjs` 或 `.ps1`）。Action Worker 在该构建项对应的 Runner 上、上传产物前执行，用相同参数 `--target/--version/--output-dir`（PowerShell 则为 `-Target/-Version/-OutputDir`）；非零退出直接阻断该构建与发布。
- 对旧清单，不填 `acceptance_script` 仍按旧方式发行；新平台应将烟雾测试、安装包完整性及关键运行路径检查包含在该脚本中。Runner 标签、任务权限、构建并行数仍由中央控制。
- 这是声明式验收而不是对所有产品强制三平台构建；未构建的原生平台绝不可标记为已验收。
- 外部 GitHub Action 必须锁定完整的不可变 40 位 Commit SHA。破坏性合同更新需要另行版本化和兼容迁移，不允许隐式放宽门禁。

## 5. 部署流程详解

```
不可变源码
→ deploy 能力
→ 源仓库 .github/deploy.json (单产品) 或 projects/<产品>/deploy.json (多产品)
→ Action Worker 源门禁
→ Runner 解析
→ 适配器
→ 受控部署
→ 健康检查
→ 回滚
```

- 只有 `AW_REPOSITORY_POLICY` 中有 `deploy` 能力的仓库才会解析部署清单
- 清单声明：`adapter`、`schema_version`、`root`、`entrypoint`、`runner_profile`、`ignore_docs_only`、`environments`
- `production-deploy` 为抽象特权 Runner Profile，实际映射由中央 Runner 策略决定
- 部署需中央策略 `deploy-secrets.json` / `deploy-environments.json` 授权；产品键 = `owner/name/product`（单产品为 `owner/name`）

### 5.1 多产品部署

一个仓库可含多产品，每产品可部署多环境。**“仓库 + 产品 + 环境”对应一个 GitHub 环境**（建在 Action Worker 仓库，名 = 清单里的 `environment`）。

清单位置决定产品：单产品用 `.github/deploy.json`，多产品用 `projects/<产品>/deploy.json`，**两种布局不能混用**。

Schema 2 示例：

```json
{
  "schema_version": "2",
  "adapter": "source-script",
  "root": "projects/web",
  "entrypoint": "projects/web/deploy.sh",
  "runner_profile": "production-deploy",
  "ignore_docs_only": true,
  "environments": {
    "web-production": { "triggers": { "push": true } },
    "web-staging": { "triggers": { "push": { "paths": ["projects/web/**", "shared/ui/**"] } } },
    "web-manual": {}
  }
}
```

- `root` = 产品目录；`push: true` 表示任改动落在 `root/**` 自动部署
- `push.paths` 相对仓库根，`/**` 表示整目录；共享代码用它纳入触发范围
- 无 `triggers` = 仅手动
- 旧 schema 1 继续有效：`automatic: true` = 全仓库 push 触发，`false` = 仅手动

自动部署判断**仅看触发路径内文件**：路径外文档不阻止代码部署，路径外代码不触发部署。

密钥按部署键授权：
- 多产品键 = `owner/name/product`，单产品 = `owner/name`
- `production` 可由多个获授权产品共用，按部署键独立执行密钥白名单；其他 Environment 不得跨产品复用
- 产品只拿自己条目授权的密钥。
- 部署工作流不注入整个 `secrets` 上下文；中央先解析仓库、环境、产品与源清单，并对源清单实施中央策略上限。
- 实际 Secret 名称以非敏感的 Job Step Outputs 形式传入固定槽位；只有对应的 `secrets[steps.secret_plan.outputs.secret_XX]` 被解析，最多 40 项，空槽位不传值。
- 复用现有的独立 GitHub Environment Secrets，无需建立 JSON 密钥包，也不需要重新录入密钥。
- `variable_sources` 声明可由非敏感 Variable 提供的部署别名，例如 `CLOUDFLARE_ACCOUNT_ID_SECONDARY`；变量由经授权的既有来源提供，不把变量伪装成 Secret。
- 对 AI Gateway，所有非敏感部署 Variables 仅由 Action Worker **已有且受保护**的 `ai-gateway-ops` Environment 提供，包括 `CLOUDFLARE_ACCOUNT_ID_SECONDARY`、资源标识、Service Binding 目标、节点/模型映射、策略及运行参数。模型标识只作为配置值传递，中央代码不固化具体模型名。受主分支与部署源/环境双重限制的运维 Job 会校验并编码完整快照；生产部署若仍从 Repository、Organization 或 `production` 看到任何 `AIG_*` 或同名 Account ID，必须失败关闭，不允许相同值覆盖、兼容回退或静默丢弃。`CLOUDFLARE_API_TOKEN_OPS`、`CLOUDFLARE_API_TOKEN_SECONDARY`、访问密钥、Tier 凭据及中心认证密钥等 Secret **绝不通过 Job Output 或普通 Variable 转交**；各自仍受原运行环境、中央部署授权与源仓库白名单约束。
- 密钥值仅在可信暂存步骤中短暂存在。逐项注册日志遮蔽，文件目录权限为 `0700`、文件权限为 `0600`，源脚本启动前删除。
- 部署子进程只继承必要系统与部署元数据、已导出的普通 Repository Variables，以及本次授权的 Secret；不继承 Action Worker 控制面密钥、Runner Token、整个 `secrets` 上下文、`NODE_OPTIONS`。
- 缺少必需密钥、源清单越权、来源冲突或超过 40 项时失败关闭；可选密钥必须同时在中央 `allowed` 与源仓库 `deploy.secrets.allowed` 中声明。
- MCP Hub 的 `production` 仅授权 `CLOUDFLARE_API_TOKEN_SECONDARY`；运行时 `MCP_*` 密钥继续保存在 Cloudflare Worker Secrets。
- AI Gateway 部署使用 Cloudflare 发布凭据；部署完成后通过公开的 `/health/ready` 检查网关就绪状态、是否降级和构建版本。接口不返回节点明细，完整 `/health` 仍受访问组权限控制。Provider/Tier/OAuth 密钥不随普通部署传入。Server Edge 维持 `server-edge-cloud-edge` 环境现有的四项授权配置。
- 本次变更不修改任何已存 GitHub 或 Cloudflare Secret 的值，且不自动部署。

并发两层：
- 流水线组：`source-script-deploy-pipeline-<仓库>-<产品>-<环境>`（输入决定，防重复启动）
- 部署作业组：`source-script-deploy-<仓库>-<产品>-<环境>`（清单解析决定，串行部署）
- **两组名必须不同**，同名会导致部署作业永远等待自身流水线

环境变量：`DEPLOY_PRODUCT`（产品目录名，根布局为空）、`DEPLOY_TRIGGER`（`push`/`manual`）。

手动启动需同时填 `product` 与 `environment`。

---

### 5.2 运维与生产部署隔离

```text
Action Worker
├─ prepare：不绑定 Environment；仅做源 SHA / CI / 策略校验
├─ MCP Hub 运维任务（如需要）：mcp-hub-ops
└─ deploy：production
    └─ 仅传 Cloudflare 部署凭据
Cloudflare Worker Secrets：保留 MCP Hub 业务运行时密钥
```

- `mcp-hub-ops`：只供确需 MCP Hub 运维凭据的任务使用。当前通用部署工作流没有 MCP Hub 专属运维 Job，不得为了占用 Environment 而新增空 Job。
- `production`：Action Worker 统一生产部署 Environment。MCP Hub 仅允许部署 Secret `CLOUDFLARE_API_TOKEN_SECONDARY`；`CLOUDFLARE_ACCOUNT_ID_SECONDARY` 是中央 Variable，不是运行时密钥。
- MCP Hub 部署所需的普通 Variables 包括 `MCP_D1_ID`、`MCP_PUBLIC_URL`、`MCP_ACTIVE_ID`，以及现有的 `GMC_WRITE_MODE`、`GMC_CONTENT_MODE`、`MCP_OAUTH_TTL` 等可选配置；实际存放位置由运维人员核实。
- `MCP_ADMIN_KEY`、`MCP_APPROVAL_KEY`、`MCP_COOKIE_KEY`、`MCP_KEYRING_JSON`、`MCP_INGEST_JWK`、`MCP_RUNTIME_KEY` 属于 Cloudflare Worker 业务运行时密钥，禁止从 GitHub 的部署 Job 转交。
- `prepare` 与 `deploy` 之间只传源仓库、commit SHA、环境、入口、Runner、产品等非敏感元数据。Job 只绑定一个 Environment，不允许通过 artifacts、outputs、日志或命令参数传递密钥。
- 该中央策略先于 MCP Hub 源仓库清单变更合并：旧 `mcp-hub-ops` 部署请求会因环境策略不匹配而拒绝；必须等 MCP Hub 后续独立 PR 更新清单与部署脚本后才能恢复部署，不得回退到旧密钥转交方式。
- 部署凭据缺失即失败，不使用 Token 回退；部署时省略 Worker Secret 不能视为已经删除 Cloudflare 端的既存密钥。停用密钥须由运维人员显式删除并核验。
- 尚须由运维人员核实 GitHub Environment Secrets/Variables 和 Cloudflare Secrets 的实际配置状态。本 PR 不读取或修改任何真实密钥，也不触发部署。

---

### 组织部署凭据环境与逻辑生产目标分离

受管源码的部署清单只声明逻辑目标（例如 `production`），Action Worker 中央 `policies/deploy-environments.json` 授权该源产品是否允许发布，`policies/deploy-credential-environments.json` 则可额外指定其唯一受保护凭据作业 Environment。未声明映射的部署仍使用原有 `production` Environment；特别授权的 FongapCDN 正式部署只在已有 `internal-vault-ops` 作业内解析并使用 `CLOUDFLARE_API_TOKEN_PRIMARY` 及非敏感 `CLOUDFLARE_ACCOUNT_ID_PRIMARY`，不读取通用任务执行器的 Secret，不通过 Job Outputs 或工件传递 Token。受保护运维 Job 不创建额外 Deployment 记录；实际发布成功后，独立的 `production` Job 创建相应 GitHub Deployment 审计记录，并不重新读取任何 Secret。此授权仅允许固定来源、产品、环境及中央白名单，不能由源码仓库自行声明或扩大，失败必须停止。项目业务代码与生产发布入口分离：原通用任务执行 Job 不因此获取运维 Token。

### 受保护任务运维变量消费

中央任务分发优先直接使用 Action Worker Repository/已授权 Organization 的任务 Variables。对 `fongap-labs/internal-vault` 中中央任务密钥策略已授权 `CLOUDFLARE_ACCOUNT_ID_PRIMARY` 的项目，当该 Variable 在任务执行 Job 的普通作用域不可见时，先由 `internal-vault-ops` 的只读受保护 Job 精确读取一个 32 位十六进制账户 ID，校验请求来源、项目及 `main`，仅用 GitHub Job Output 交付这一非敏感值；执行 Job 再核对无来源冲突后写入当前任务进程的 `GITHUB_ENV`。仓库级已可见时跳过运维 Job，减少人工审批。运维 Job 不 checkout 业务仓库、不运行业务代码，不读取/输出任何 Secret。可选/必需 Secret 仍通过原任务 32 槽位白名单从执行 Job 可见的受保护来源注入；不得以本机制跨 Job 传 Secret，也不得绑定整个通用任务执行 Job 到 `internal-vault-ops`。私有隔离试点保持原 NO-GO/准入规则，不借此放宽。

### 组织级配置作用域自动审计

审计采用严格的分级权限证据：全组织完整元数据优先；组织级权限受限时收缩到 Action Worker 控制仓库；若仅 Environment Secret 名称接口返回确认的权限拒绝，继续读取同 Environment 的 Variables 名称，标记 `environment_secret_scope_verified=false` 和未知 Secret 统计；若 Environment 元数据整体仍受限，则只发布已核实的仓库级聚合数量，并将环境统计置为 `null`。所有降级均禁止读取值、权限提升和自动凭据迁移，且只有权限拒绝可以降级，分页异常与其他请求错误必须失败关闭。


Action Worker 的 `.github/workflows/audit-config-scope.yml` 在中央策略变更合并后与日常漂移检查时自动运行，绑定**本仓库的 `admin-ops` Environment**，复用现有受保护 `AW_ADMIN_TOKEN` 只读调用 GitHub 元数据 API。`scripts/config-storage-audit.ts` 自动审计 `policies/config-audit-targets.json` 与 `policies/repository-access.json` 的受管仓库并集，检查组织/仓库/Environment 级 Secret、Variable 的名称、继承及遮蔽情况。只输出聚合计数和未验证声明。GitHub Variables 列表 API 响应可能包含值，审计器仅提取名称并丢弃值，绝不写日志或工件；Secret 列表 API 不返回 Secret 值。不修改其他仓库的设置，也不通过 Job Output 跨环境传递 Secret。组织级元数据读取因 GitHub 403 权限拒绝时，自动收缩为 Action Worker 控制仓库范围，返回 `coverage=control-only` 且组织继承及相关遮蔽统计为 `null`（未知，绝不视作零）；仓库级/Environment 数据仍须完整、授权可读，否则失败关闭。分页不完整、其他权限和速率限制错误也不得猜测配置不存在。不要求业务仓库重复配置，也不自动扩大令牌权限。

## 6. 定时部署

在环境 `triggers` 中加 `schedule`（五段式 cron，UTC）：

```json
{
  "schema_version": "2",
  "adapter": "source-script",
  "root": "projects/web",
  "entrypoint": "projects/web/deploy.sh",
  "runner_profile": "production-deploy",
  "ignore_docs_only": true,
  "environments": {
    "web-staging": { "triggers": { "schedule": ["0 12 * * *"] } }
  }
}
```

规则：
- 调度器每次运行回看 12 小时（`DEPLOY_SCHEDULE_LOOKBACK_MINUTES=720`），为每“产品+环境”找最近到期时间点
- 只派发最近一个时间点；错过的更早时间点**不补跑**
- Intake 在派发前写入带签名的预留状态；每个时间点最多发起一次派发请求。若结果不明确或下游部署失败，不会自动重发，维护者需先核对对应的 Intake 与部署运行，再决定是否手动恢复
- 只有 GitHub 接受请求后才写成功回执；有效预留和成功回执都阻止该时间点再次自动派发
- 只部署中央 CI 已通过的默认分支；红分支或未通过则跳过，不回退部署旧提交
- 运行摘要显示 UTC 与北京时间
- 定时部署环境**不能**设置必需审批人
- 请求带 `trigger: schedule`；清单无 `schedule` 的环境会被拒绝

---

## 7. 跟随型产品

跟随型产品 = 独立产品但依赖上游某已发布版本。上游发布成功后，Action Worker 为每个跟随方开 PR，将固定版本改为新发布版本。

跟随方在仓库放 `follows.json`：

```json
{
  "upstream": { "repository": "your-org/shared-lib", "release_key": "shared-lib" },
  "pins": [
    { "path": "requirements.toml", "key": "shared.version", "value": "version" },
    { "path": "lock/shared.json", "key": "/shared/commit", "value": "commit" }
  ],
  "lockfile": "uv"
}
```

- `upstream.repository` + `release_key` 定位上游发布
- `pins`：每项写 `path`（相对仓库根）、`key`（JSON Pointer 或 TOML 点分路径）、`value`（`version` 或 `commit`）
- 仅改声明处；注释里旧值不改
- `lockfile: "uv"` 时，沙箱跑 `uv lock`，把 `uv.lock` 差异作为产物交回

自动流程：
1. 上游发布成功
2. 控制域在 `aw/follow/<产品>` 分支改 `pins` 声明文件，开/更新 PR
3. 若声明 `lockfile: "uv"`，沙箱跑 `uv lock`，`uv.lock` 差异随 PR 提交
4. 控制域检查差异仅涉及 `uv.lock` 且分支未被推进，只提交这一文件

发布前检查：每个 `pins` 值必须对应上游某已发布版本/标签提交；否则拒绝并指出文件与键。

维护者须知：
- `[tool.uv] required-version` 必须精确版本（如 `==0.9.1`）
- 沙箱只读检出令牌，`uv lock` 无法访问私有仓库依赖；私有 git 依赖需额外凭据
- 跟随 PR 只含声明文件，无其他改动
