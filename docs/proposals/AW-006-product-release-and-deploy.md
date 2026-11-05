# 提案 AW-006：按产品发布与部署

状态：**第 1 步、第 2 步、第 3 步（含 3b）、第 4 步（跟随）与定时部署已实施；第 5 步（仓库迁移）按需，不强制执行**。本提案替代"一个仓库只有一个发布清单与一个部署清单"的假设，覆盖三类仓库：多产品仓库、单产品仓库、跟随型产品。

## 1. 背景

当前的发布与部署把"仓库"当作"产品"。已在代码中确认的限制：

1. 发布清单固定在仓库根目录 `.github/release.manifest.json`（`scripts/validate-release-build-request.ts` 读取该路径）。
2. 部署清单固定在仓库根目录 `.github/deploy.json`（`scripts/deploy-manifest.ts` 读取该路径）。
3. 部署并发组按仓库分组（`deploy-source-script.yml` 的 `concurrency.group` 为 `source-script-deploy-<仓库>`），同一仓库的所有产品互相排队。
4. 密钥白名单（`policies/deploy-secrets.json`）与环境白名单（`policies/deploy-environments.json`）按仓库键分组，同一仓库的产品无法拥有独立的密钥范围。
5. 自动部署的"只改文档则跳过"判断以整个提交为单位，一个产品的改动会触发整个仓库的部署。
6. 构建脚本写死了项目路径，换一个产品就必须改脚本。
7. 跟随型产品的固定版本靠手动修改依赖文件，发布治理要求人工填写版本号。

三类仓库：

- **多产品仓库**：一个仓库包含多个软件或服务。
- **单产品仓库**：一个仓库只有一个软件。
- **跟随型产品**：自身是独立产品，但它依赖另一个产品的某个发布版本，例如某产品的高级版。

## 2. 原则

- 产品由自己的清单声明。中央代码不保存产品名称，也不保存"仓库与产品"的绑定。
- 中央只授权仓库能力（`release-source`、`release-target`、`deploy`）。产品级策略作为数据放在中央策略文件中，键为 `<仓库>/<产品>/<环境>`。
- 产品目录统一为 `projects/<目录名>/`。目录名由产品决定，中央通过扫描发现，不写入代码。
- 兼容：仓库根目录的清单继续有效，视为单产品仓库，直到该仓库迁移。
- 版本号仍在发布启动时由人工输入，不从仓库读取。

## 3. 产品模型

```text
projects/<目录名>/
  release.manifest.json   # 可选：发布清单
  deploy.json             # 可选：部署清单
  follows.json            # 可选：跟随声明
  ...                     # 产品源码与构建脚本
```

清单结构沿用现有格式，并有以下约定：

- `builds[].script` 相对于产品目录解析。
- 部署清单可以声明 `triggers.paths`，列出自动部署的触发路径；未声明时默认为产品目录。用于共享代码位于产品目录之外的情况。
- 清单中不声明产品目录本身，它由扫描结果决定。

## 4. 发现与校验

- 中央在源提交上列出 `projects/` 下含有发布清单或部署清单的目录。
- 同一仓库内，发布键（`release_key`）与部署标识必须唯一；重复则拒绝，并列出冲突的目录。
- 跨仓库的唯一性由发布标签（`<release_key>-v<版本>`）与目标仓库的已存在检查保证。同一产品的同一版本再次发布会被拒绝。
- 仓库只有一个产品时，`product` 输入可以留空；有多个产品时必填，且必须是发现结果中的目录名。

## 5. 发布

- `Release App` 的输入为 `source_repository`、`product`（条件必填）与 `requested_version`。
- 清单路径由发现结果决定，不由输入决定。
- 并发组为 `release-build-<仓库>-<产品>-<源提交>-<运行号>`。
- 构建脚本接收产品根目录作为参数，取代写死的路径。

## 6. 部署

- `Deploy Source Script` 的输入同样增加 `product`。
- 并发组为 `source-script-deploy-<仓库>-<产品>`。
- 自动部署的触发范围由 `triggers.paths` 决定，"只改文档"的判断在该范围内进行。
- 密钥白名单与环境白名单的键为 `<仓库>/<产品>`（单产品仓库仍为 `<仓库>`），环境是键下的一层。这些数据放在中央策略文件中，中央代码不写产品名。

## 7. 跟随型产品

- 跟随方在自己的 `follows.json` 中声明上游与固定值。单产品仓库放在 `.github/follows.json`，多产品仓库放在 `projects/<目录名>/follows.json`（与 §3 一致）：

  ```json
  {
    "upstream": { "repository": "<上游仓库>", "release_key": "<上游发布键>" },
    "pins": [
      { "path": "<依赖文件路径>", "key": "<键>", "value": "commit" },
      { "path": "<依赖文件路径>", "key": "<键>", "value": "version" }
    ],
    "lockfile": "uv"
  }
  ```

- `pins[].path` 相对于仓库根目录。`key` 对 JSON 是 JSON Pointer，对 TOML 是点分路径。`value` 为 `commit`（40 位提交号）或 `version`（SemVer）。`lockfile` 可选，目前只支持 `uv`。
- 文件以"逐处替换、再解析比对"的方式修改：每个键只能对应一处旧值，最终文件只能改动声明的键。不做整体正则替换，也不重新序列化。
- 上游发布成功后，中央为每个跟随方在 `aw/follow/<产品>` 分支上提交一次（只含 `pins` 声明的文件），并开或更新 PR。该 PR 按跟随方的正常 PR 治理审查与合并。
- 声明了 `lockfile: "uv"` 时，沙箱在该提交上运行 `uv lock`（不携带中央凭据，依赖的 uv 版本取 `[tool.uv] required-version`，必须是精确版本），把 `uv.lock` 的差异作为产物交回。控制域只在差异仅涉及该 `uv.lock` 且分支未被推进时，提交这一个文件。
- 发布前校验：跟随方发布时，每个 `pins` 项在源提交上的值，必须对应上游某个已发布标签（版本号）或已发布标签的提交（commit），否则拒绝发布。
- 跟随方的发布仍由人工启动，并由人填写版本号。
- 中央用 `AW_CONTROL_TOKEN` 写入跟随分支与 PR，且只允许修改 `pins` 声明的文件与声明的 `uv.lock`。

## 8. 安全边界

- 跨仓库 PR 只修改声明的文件，不执行被修改仓库的代码。
- 密钥仍按部署键授权。一个产品不能请求其他产品的密钥。
- 并发组与密钥键都包含产品，两个产品不会互相覆盖或排队到对方之后。

## 9. 迁移

- 根目录清单继续有效，不强制迁移。
- 需要多产品的仓库：把清单与构建脚本移到 `projects/<目录名>/`，并在中央策略中登记各产品的部署键。
- 跟随型产品：增加 `follows.json`。

## 10. 实施计划

按 PR 拆分，每步都保证单产品仓库的行为不变：

1. **产品发现与发布输入（已实施）**：扫描 `projects/`，增加 `product` 输入，发布路径按产品解析。
   - 发现逻辑在 `scripts/product-discovery.ts`，部署与跟随复用同一模块。
   - 只有含 `release.manifest.json`、`deploy.json` 或 `follows.json` 之一的目录才是产品。
   - 产品的 `root` 写在源仓库清单中（`contracts/release-build.json`）。`contracts/release-manifest.json` 是已发布的产物清单，不含 `root`。
   - §3 中"清单不声明产品目录"指产品目录由扫描决定；`root` 只决定构建在哪里进行，两者不冲突。
   - 构建脚本仍位于仓库根目录的 `.github/scripts/`，按产品放置脚本留给第 2 步。
2. **构建脚本参数化**：构建脚本接收产品根目录；清单路径相对于产品目录。
3. **部署产品化**：并发组、密钥与环境键、自动部署的触发路径。
4. **跟随型产品**：`follows.json` 与固定版本 PR。
5. **仓库迁移**：每个仓库单独一个 PR。

测试覆盖：单产品回归、多产品发现、重复键拒绝、并发组唯一性、跟随 PR 只修改声明的文件、跨产品密钥隔离。

### 10.1 第 3 步的实施记录

已实施（`tests/deploy-manifest.test.ts`、`tests/deploy-dispatch.test.ts`、`tests/deploy-policies.test.ts`、`tests/deploy-source.test.ts`）：

- 清单同时支持 schema 1（原样保留）与 schema 2。schema 2 的环境可以声明 `push`（`true` 或 `paths`）与 `schedule`。
- schema 2 的 `root` 只决定 `push: true` 的触发路径（`root/**`）；`entrypoint` 与 schema 1 一样相对于仓库根目录。
- 分发按（产品，环境）逐个判断。路径未命中则跳过；"只改文档"的判断只看触发路径之内的文件。
- 并发组与密钥键包含产品。根目录布局的并发组为 `source-script-deploy-<仓库>-<环境>`，这是相对于第 3 步之前的一处变化。
- 产品布局的密钥范围总是 enforce，不受 `AW_DEPLOY_SECRET_POLICY_MODE` 影响：否则 warn 模式会放行产品声明的其他产品的密钥名。根目录布局不变。
- 密钥声明文件放在产品目录（`projects/<产品>/deploy.secrets.*`，根目录布局为 `.github/`）。早先的任务描述写作 `.github/products/<产品>/`，与本提案 §3 和第 1 步已落地的发现逻辑冲突，以本提案为准。

定时部署（第 6 节的定时触发）已实施：

- `scripts/cron-schedule.ts` 承载 cron 解析与"最近到期时间点"计算，定时任务共用，行为不变。
- `scripts/dispatch-scheduled-deploys.ts` 为每个"产品 + 环境"派发最近一个到期的时间点，回看 `DEPLOY_SCHEDULE_LOOKBACK_MINUTES`（720）分钟，去重状态为 `Deploy Schedule/<产品>/<环境>`（单产品为 `Deploy Schedule/<环境>`）。
- 只部署中央 CI 已通过的默认分支；红色或未通过则本次跳过，不改去部署更早的提交。
- `intake.yml` 的 `deploy-schedules` 作业运行它；派发的请求带有 `trigger: schedule`。

已完成：
- 3b（PR 缺口提示，§6 第 2 条）：`scripts/check-deploy-gap.ts` 在 PR 治理中提示缺失的中央策略条目。
- 构建脚本参数化（第 2 步）：清单路径相对产品根目录，脚本接收 `RELEASE_PRODUCT_ROOT`。

未完成或未验证：
- 自动部署与人工审批的互斥检查已实现，并在读取失败时拒绝部署；但尚未用真实的控制凭据确认能读取环境保护规则。
- 第 5 步（仓库迁移）：§9 明确不强制迁移，当前无业务仓库需要多产品，按需执行。

### 10.2 第 4 步的实施记录

- 跟随的解析与修改在 `scripts/follow-pins.ts`（纯函数）；GitHub 访问在 `scripts/follow-github.ts`；控制域的分支与 PR 在 `scripts/dispatch-follow-updates.ts`；沙箱的 `uv lock` 在 `scripts/lock-follow.ts`；控制域只提交 `uv.lock` 的在 `scripts/commit-follow-lock.ts`。
- TOML 解析使用 `smol-toml` 1.9.0（精确版本，零依赖，发布于 2026-09-22，满足"发布满两周"）。1.9.1 发布于 2026-10-09，未采用。
- 跟随方的 `follows.json` 位置遵循 §3；本次的 `.github/products/` 写法与 §3 冲突，未采用。
- 错误信息使用英文，因为它们属于工程 diff（见 `docs/01_SHARED_GOVERNANCE.md` §2）。

## 11. 未决问题

- ~~固定版本文件的匹配规则是否统一为正则，还是按文件类型提供解析器。~~ 已决定：按文件类型提供解析器（JSON 用 JSON Pointer，TOML 用点分路径），见 §7 与 §10.2。
- 中央策略中的产品部署键由哪一方提交：建议由仓库所有者提交，中央审核。
