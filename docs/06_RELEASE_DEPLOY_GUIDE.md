# 发布 / 部署运维手册

本文档面向维护者，记录手动操作步骤、常见失败排查、多产品布局、定时部署、跟随型产品等运维细节。接入指南见 `05_INTEGRATION_GUIDE.md`。

---

## 1. 发布 / 部署工作流速查

| 目的 | 工作流 | 手动输入 | 自动触发 |
|------|--------|----------|----------|
| 发布由源仓库构建的应用 | `手动 · 发布应用` (`release-app.yml`) | `source_repository` (owner/name)、`requested_version` (正式版 `X.Y.Z`，beta 版 `X.Y.Z-beta.N`，可留空=自动计算正式版)、`product` (多产品时必填) | `run-release-build` 分发事件 |
| 发布上游镜像的第三方工具 | `自动 · 工具发布` (`release-tool.yml`) | 无 | 定时，每 6 小时 |
| 部署某个源提交 | `手动 · 部署服务` (`deploy-source-script.yml`) | `source_repository` (owner/name)、`source_sha` (可选，留空=当前 HEAD) | 中央 CI 通过且部署清单声明 push 触发 |

> 只有 `手动 · 发布应用`、`手动 · 部署服务`、`手动 · 派发任务` 有 Run workflow 按钮；其余工作流自动运行。

---

## 2. 启动前检查清单

启动 `手动 · 发布应用` 或 `手动 · 部署服务` 前，**无需**手动准备 CI/main-write 证明——工作流会自动申请并等待最多 20 分钟。仅需确认：

1. 目标改动已通过 PR 合并进 `main`
2. `source_repository` 写成 `owner/name`，且该仓库在 `AW_REPOSITORY_POLICY` 中具备对应能力（`release-source` / `deploy`）
3. 发布时 `requested_version` 手动填写：正式版如 `1.2.3` 或 `v1.2.3`，beta 版如 `1.2.3-beta.1`（作为预发布发布）。留空由 Action Worker 按上次正式版之后的 Conventional Commits 自动计算下一个正式版

---

## 3. 常见失败与对策

| 日志报错 | 原因 | 处理 |
|----------|------|------|
| `Invalid repository: x. Enter it as owner/name` | 只写仓库名 | 按提示写成 `owner/name` |
| `Repository is not allowed for <能力>` | 仓库缺少能力 | 报错末尾列出具备该能力的仓库；需新增时修改 `AW_REPOSITORY_POLICY` |
| `Requested release version must be X.Y.Z (formal) or X.Y.Z-beta.N` | 版本不是三段数字，或预发布后缀不是 `-beta.N`（N ≥ 1） | 改成 `1.2.3`、`v1.2.3` 或 `1.2.3-beta.1` |
| `No release-worthy Conventional Commits since <base>. Cut a change or enter an explicit requested_version.` | 自动模式下跨度内没有 feat/fix 等可发布提交 | 合并新改动的 PR 后重启，或显式填一个稳定版本 |
| `Commit subjects are not Conventional Commits titles (CHANGELOG_CONVENTIONS.md §3): ...` | 自动模式跨度内混入未按规范书写的提交标题 | 修正提交信息（PR 标题即提交标题），或显式填稳定版本跳过自动计算 |
| `The commit span holds N commits, more than ... accepts. Enter an explicit requested_version instead.` | 距上次发布积累的提交太多（compare 截断 / 跨度上限 / 产品根过滤上限） | 显式填稳定版本，让本次发布先落地 |
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
| `Invalid CHANGELOG entry` / `CHANGELOG uses unsupported category` / `must be Chinese text` | CHANGELOG 写成 `- 修复: 中文摘要`，类别取自六类，摘要用中文（见 `04_CHANGELOG_CONVENTIONS.md` §5） |
| `Attribution check failed` | 作者/提交者/trailer/署名行出现 AI 名称。改成自己的 GitHub 账号，重写提交，强制推送 |

---

## 4. 发布流程详解

```
不可变源码
→ Action Worker 中央构建/打包
→ release-manifest + provenance
→ Release Governance
→ 版本小节 PR（chore(release): <tag>）→ 门禁 → 合并
→ 合并提交上打 tag、创建 Release
→ 重新下载校验
→ 完成 / 回滚
```

- 版本小节由中央依据目标仓库的 `CHANGELOG.md` 与 `changelog.d/` 条目文件生成，经 PR 合入后才打 tag。发布 PR 只能改 `CHANGELOG.md` 并删除已汇总的条目文件，校验器会从基线重新计算，内容不一致即拒绝。
- 版本说明：产品清单的 `release_notes` 非空时使用它；为空时使用本次版本小节。提交跨度清单不再作为版本说明来源。
- 没有条目文件也没有未发布条目的仓库无法发布，会以 `No CHANGELOG entries to release` 失败。
- 发布 PR 等待门禁的时间计入发布时限（默认 30 分钟）。门禁失败时 PR 保持开放，重跑会复用它，不会新开。

- 业务仓库保留构建/打包脚本，在 `.github/release.manifest.json`（单产品）或 `projects/<产品>/release.manifest.json`（多产品）声明构建目标、产物、`runner_profile`
- Manifest **不含版本**；版本仅来自发布启动时手动输入
- 项目构建脚本必填 `-Version` 参数，将版本写入构建产物并校验

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
- 同一环境名全策略仅属一个键
- 产品只拿自己条目授权的密钥

并发两层：
- 流水线组：`source-script-deploy-pipeline-<仓库>-<产品>-<环境>`（输入决定，防重复启动）
- 部署作业组：`source-script-deploy-<仓库>-<产品>-<环境>`（清单解析决定，串行部署）
- **两组名必须不同**，同名会导致部署作业永远等待自身流水线

环境变量：`DEPLOY_PRODUCT`（产品目录名，根布局为空）、`DEPLOY_TRIGGER`（`push`/`manual`）。

手动启动需同时填 `product` 与 `environment`。

---

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
- 每个时间点只派发一次；派发后在默认分支提交上写入 `Deploy Schedule/<产品>/<环境>` 状态
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