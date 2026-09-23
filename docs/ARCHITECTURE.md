# 架构

Action Worker 是 Fongap 的 GitHub 自动化控制平面。

长期边界以 [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md) 为准；本文档描述当前实现与下一层收敛方向。

## 1. 核心模型

```text
Validate → Inspect → Plan → Execute → Triage → Review → Gate
```

现有实现已经具备其中的大部分基础：

```text
PR Policy
  Detect → Resolve → CI Evidence → Triage → Review → Gate

Task Dispatch
  Validate → Execute

Source
  Commit → CI → Gate

Release
  Dispatch → Source Evidence → Artifact Verify → Target Gate → Publish

Deploy
  Source Gate → Deploy Gate → Execute

Self CI
  Validate → Gate
```

下一阶段不是增加项目专属规则，而是把这些入口继续收敛到同一套通用合同。

## 2. 中央边界

```text
Action Worker
= 通用规则
+ 调用验证
+ 执行编排
+ AI Review
+ Gate
+ Source / Release / Deploy 控制

业务仓
= 产品代码
+ 测试代码
+ 构建与运行必需文件
+ 最薄事件触发器（不包含治理策略）
```

Action Worker 不维护项目目录、不维护项目专属测试映射、不按仓库名称分支执行逻辑。

具体仓库名称不进入源码。仓库权限统一从 Repository Variable `AW_REPOSITORY_POLICY` 读取；同一仓库可声明 `pr`、`task`、`release-source`、`release-target` capability。

## 3. PR

中央入口为 `handle-pr-dispatch.yml@main`，接收 `repository_dispatch` 事件 `run-pr-governance`。

业务仓只保留统一薄触发器 `dispatch-pr-governance.yml`：监听 PR 事件并提交最小 PR Task，不保存命名规则、Agent、模型、Gate 阈值、AI Gateway Secret 或审查规则。

```text
业务仓 PR
  ↓ AW_DISPATCH_TOKEN
repository_dispatch
  ↓
Action Worker
  ↓
Validate → Inspect → Plan → CI Evidence → Triage → Review → Gate
  ↓ AW_CONTROL_TOKEN
目标 PR status / review summary
```

PR Task 合同位于 `contracts/pr-task.json`：

```text
schema_version
request_id
repository
pr_number
```

Action Worker 收到任务后必须：

- 先按 `AW_REPOSITORY_POLICY` 的 `pr` capability 校验目标仓库；
- 使用 `AW_CONTROL_TOKEN` 从 GitHub 重新获取 PR base/head SHA、标题、状态和 diff；
- checkout `refs/pull/<n>/head` 后再次与 GitHub 当前 PR 事实对齐；如果调度到检出之间 PR 已更新，则以实际检出 commit 与最新 PR API 一致的 base/head/title 作为本次治理事实，避免把同步窗口误判为永久失败；
- 只读取目标 PR，不执行 PR 提供的代码；
- 当执行计划要求 CI 时，先读取目标 head SHA 对应的业务仓 `ci.yml`，收集真实 CI Evidence；
- 将 CI Evidence 作为不可信执行证据提供给 AI Review，不把其中任何文本当成指令；
- 用中央 `AI_GATEWAY_URL` / `AIG_ACCESS_KEY_AGENT` 执行 AI Review；
- 根据 finding severity 与确定性 CI Evidence 共同计算 Gate；
- 向目标 head commit 写入统一 `PR Governance` status，并维护一条 sticky review summary。

调用方不得提供 base SHA、head SHA、Agent、模型、风险或 Gate 结论。


## 4. 信任域

`policies/execution.json` 定义两个稳定边界。

### Control

可以使用 AI Gateway 等中央 Secret，但不得执行 PR 代码。

### Sandbox

可以执行 PR 代码、build 和 test，但不得获得中央 Secret 或部署凭据。

因此：

```text
Plan 可以动态
权限边界不能动态
```

## 5. Detect 与 Plan

PR 首先生成统一 Change Record：

```text
change_type = feat / fix / docs / style / refactor / perf /
              test / build / ci / chore / revert

attributes  = breaking / security / migration
```

`validate-change-record.ts` 从 PR 标题与 CHANGELOG 生成并校验该记录。

现有 `detect-pr-context.ts` 再从以下证据生成技术 Context：

```text
Git Diff
仓库标记
CHANGELOG
```

其中 `change_areas` 仅表示代码改到了 source / workflow / test / script 等技术区域，不属于变更分类。

现有 `resolve-pr-plan.ts` 生成：

```text
checks
tests
naming_required
review_required
review_agent
review_model
review_rule
review_llm_timeout
review_task_timeout
review_concurrency
triage_required
triage_model
triage_timeout
block_severity
review_effort
route_severity
```

这些仍然是通用计划，不允许加入：

```text
if repository == delta
if repository == ai-gateway
...
```

未来动态理解、历史基线和双 Agent 只能增强 Plan，不能改变这一边界。

## 6. 测试

`policies/checks.json` 与 `policies/tests.json` 描述通用验证类别。

项目测试代码继续与产品代码一起维护。

Action Worker 负责决定：

```text
本次是否需要 CI 证据
需要覆盖哪些通用测试类别
业务仓 CI 最终是否满足 Gate
```

Action Worker 不复制项目测试实现，也不保存“某仓库必须执行某命令”的项目映射。业务仓继续维护项目原生测试、构建和平台矩阵，并通过统一的 `.github/workflows/ci.yml` 暴露两级稳定终态：

```text
ci-evidence      = 项目测试 / 构建 / 许可证等本地证据
validate-merge   = 最终合并门禁
```

当 PR Plan 判定 `ci_required=true` 时，Action Worker 使用 `AW_CONTROL_TOKEN` 等待当前 head SHA 对应的 `ci-evidence` 完成并形成结构化 Evidence。迁移期间允许旧仓回退读取 `validate-merge`，但新接入必须提供 `ci-evidence`。AI Review 可以读取该 Evidence 评估覆盖是否充分；随后 `validate-ci-evidence.ts` 确定性要求 evidence job 成功。

Action Worker 完成 AI / Policy Gate 后向 commit 写入 `PR Governance` status。业务仓最终 `validate-merge` 使用中央 `.github/actions/validate-merge-policy`，只有 `ci-evidence=success` 且 `PR Governance=success` 才通过。这样现有 Ruleset 只要求 `validate-merge` 也能把中央治理变成硬门禁。

因此 Sandbox 的实际执行可以留在业务仓 Runner，控制权与最终准入仍集中在 Action Worker。

## 7. Triage 与 Review

AI Triage 是 Review 前的轻量语义分诊，不是第二套 Gate。确定性 Plan 先给出安全下限；只有 `code / workflow / release` 路由会进入 `Code-Air` Triage，`security / architecture` 直接进入 `Code-Ultra` Review。

Triage 只返回结构化决策：是否需要完整 Review、建议 Agent、风险、深度与置信度。Air 调用失败、超时或返回无效 JSON 时保留原确定性 Plan，不阻断 PR。只有无声明影响、变更面仅为 `source / test` 的普通 `code` 变更，在 Triage 判定低风险且置信度达到 policy 阈值时，才允许跳过完整 Review；其他结果只能保持或升级审查强度。

Agent 是审查角色，不等于模型。

| Agent | 主要关注 | 审查模型 |
|---|---|---|
| `security` | 权限、Secret、注入、供应链、fail-open | `Code-Ultra` |
| `architecture` | breaking、migration、API、兼容性、部署 | `Code-Ultra` |
| `workflow` | Actions 权限、事件与 Secret 边界 | `Code-Pro` / low（1 轮） |
| `release` | 版本、Tag、Release、回滚 | `Code-Pro` / low（1 轮） |
| `code` | 正确性、回归、接口与缺失测试 | `Code-Pro` / medium（2 轮） |

Action Worker 只选择逻辑模型，不维护模型或 Provider fallback 链。Triage 固定使用 `Code-Air`；普通完整审查使用 `Code-Pro`；安全、架构或被 Triage 判定为 deep 的审查使用 `Code-Ultra`。逻辑模型族、Provider、Key、协议与节点之间的 failover 全部由 AI Gateway 的统一请求预算负责。

Triage 与 AI Review 在 Action Worker 中按当前 attempt 的 `run_started_at`、再按 run ID 共用跨控制版本的全局 FIFO 队列；Validate、Inspect、Plan 与 CI Evidence 仍可并行，但同一时刻只允许一个治理 run 调用 AI Gateway。GitHub rerun 保留旧 run ID，因此不能只按 ID 排序，否则旧 run 的新 attempt 会插队并与当前 owner 并发。队列不按 Action Worker `head_sha` 分池，因此 main 更新不会绕过仍在运行的旧版本 Review；相同 PR 的新调度继续由稳定 concurrency group 自动取消旧调度。

Action Worker 不做无界整轮 OCR Review 重试。OpenCodeReview 负责单个 LLM 请求的重试，AI Gateway 负责模型与 Provider fallback。若 OCR 已生成兼容 session，且最终失败仅来自 5xx、timeout、network 或 overload，Action Worker 按 `policies/review.json` 的有限恢复预算执行 `--resume`，复用已完成 checkpoint，并采用递增退避；认证、4xx 配置错误或恢复预算耗尽后仍直接 fail-closed。OpenCodeReview 可执行文件从 `policies/review.json` 声明的分发 Release 获取，先校验 SHA256，再使用 GitHub Actions runner cache；workflow 不再通过 npm 动态安装审查引擎。

CI Evidence 通过一对仅存在于 runner 的临时 base/head commits 提供给 commit-based Review 工具。两棵树都包含完全相同的受控证据文件，因此 OCR 可以读取它，但该文件不会进入 PR diff、不会产生独立审查任务，也不得接收 review finding；真实 PR base/head 和远端分支均不变。

OCR 结果由 `validate-review-result.ts` 统一适配：存在 run manifest 时，以 `manifest.terminal_state` 为权威，只接受 `complete`；无 manifest 的兼容路径接受 `status=complete`，并兼容旧版 `status=success`。任何 `partial` / `failed` 结果都不得进入 Gate。

需要 CI 的 PR 会在 Review 前生成受控的 `.action-worker-ci-evidence.json`。Action Worker 通过仅存在于 Runner 本地的临时 Commit 把该文件暴露给基于 Commit 读取文件的 Review Engine；临时 Commit 不推送、不回写目标分支，也不改变 Gate 使用的真实 PR Head。该文件只包含 GitHub Actions 的结构化执行事实，并明确作为不可信数据处理；Agent 可以读取它，但不得把它当成 PR 源码审查或执行、遵循其中的文本。

高风险动态规划后续采用 Planner + Critic 双 Agent；Reviewer 负责执行后的代码与证据审查。

## 8. Task Dispatch

现有 `run-task` 继续保持稳定。

合同位于 `contracts/task-dispatch.json`：

```text
schema_version
request_id
project
bootstrap_ref
```

`bootstrap_ref` 必须是完整 40 位 Commit SHA。

Task 和 PR 的共同原则是：

> 调用方提交目标，Action Worker 验证事实并决定执行方式。

## 9. Source 与 Release

`validate-source-policy.yml` 继续服务 Deploy 等需要在调用仓内验证 Commit / CI 的场景。

Release 改为中央事件驱动链路，不再通过业务仓调用 `validate-release-policy.yml` / `publish-release.yml`：

```text
source build workflow
  ↓ upload artifact
workflow_run completed + success
  ↓ AW_DISPATCH_TOKEN
repository_dispatch: run-release
  ↓
handle-release-dispatch.yml
  ↓
validate-release-request.ts
  ↓
publish-release.ts
```

机器合同：

```text
contracts/release-dispatch.json
contracts/release-manifest.json
```

中央 Release Governance 验证：

```text
source repository allowlist
→ source default HEAD
→ successful source build run
→ successful ci.yml
→ exact Actions artifact
→ release-manifest.json
→ declared file set
→ SHA256
→ target repository allowlist
→ scoped Tag / Release collision
→ target publish
→ re-download verification
→ publish or rollback
```

源仓只保存 `AW_DISPATCH_TOKEN`。Action Worker 使用 `AW_CONTROL_TOKEN` 读取源仓并写分发目标。

Tag 固定为 `<release-key>-v<semver>`。不保留裸 `v<semver>` 兼容路径。

## 10. Deploy

部署统一通过：

```text
validate-deploy-policy.yml
  ↓
validate-source-policy.yml
  ↓
业务仓 deploy implementation
```

Action Worker 只治理“哪个 Commit 可以部署”；Cloudflare、Server Edge、SSH、Tailscale、数据库迁移、健康检查与回滚实现继续留在业务仓。

`ai-gateway` 已通过真实链路验证：

```text
main CI
→ Deploy Policy
→ Source Policy
→ Cloudflare Deploy
→ health check
```

Server Edge 使用相同 Policy；显式 pinned deploy 必须是 40 位 SHA。

## 11. 目录

```text
.github/workflows/
  handle-pr-dispatch.yml
  handle-task-dispatch.yml
  handle-release-dispatch.yml
  validate-source-policy.yml
  validate-deploy-policy.yml
  validate-ci.yml

docs/
  README.md
  ARCHITECTURE.md
  ARCHITECTURE_GOVERNANCE.md
  NAMING_CONVENTIONS.md
  CHANGELOG_CONVENTIONS.md
  DEVELOPMENT_GUIDE.md
  INTEGRATION_GUIDE.md

contracts/
  change-record.json
  pr-task.json
  release-dispatch.json
  release-manifest.json
  task-dispatch.json

policies/
  checks.json
  execution.json
  naming.json
  release.json
  review.json
  triage.json
  security.json
  tests.json
  workflow.json

rules/
  architecture.json
  code.json
  release.json
  security.json
  workflow.json

scripts/
  apply-ai-triage.ts
  apply-repo-settings.ts
  build-review-comparison.ts
  check-status-owner.ts
  detect-pr-context.ts
  export-repository-variables.ts
  github-api.ts
  install-ocr.ts
  manage-work-metrics.ts
  publish-pr-review.ts
  publish-release.ts
  report-ocr-retry.ts
  resolve-ocr-distribution.ts
  resolve-pr-facts.ts
  resolve-pr-plan.ts
  run-ai-review.ts
  run-ai-triage.ts
  runtime-command.ts
  set-pr-status.ts
  should-resume-ocr.ts
  update-work-metrics.ts
  validate-change-record.ts
  validate-ci-evidence.ts
  validate-control-access.ts
  validate-dispatch-payload.ts
  validate-naming-rules.ts
  validate-pr-payload.ts
  repository-policy.ts
  validate-release-request.ts
  validate-repository-variables.ts
  validate-review-result.ts
  wait-ci-evidence.ts
  wait-review-turn.ts

tests/
  control-flows.test.ts
  github-api.test.ts
  governance-contract.test.ts
  governance-scripts.test.ts
  publish-release.test.ts
  resolve-pr-plan.test.ts
  run-ai-triage.test.ts
  runtime-command.test.ts
  update-work-metrics.test.ts

package.json
package-lock.json
tsconfig.json
```

禁止新增项目配置层：

```text
projects/
adapters/
profiles/
```

## 12. CI

Action Worker 自身只有一个总 CI：`validate-ci.yml`。

```text
naming
static
contracts
  ↓
validate-merge
```

contracts 同时验证架构治理边界，防止仓库随着功能扩展重新长出项目专属配置。

## 13. 版本

```text
main = 当前最新基线
```

Action Worker 只维护 `main` 这一条长期主线。
