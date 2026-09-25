# 架构

Action Worker 是 Fongap 的 GitHub 自动化控制平面。

长期边界以 [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md) 为准；统一执行合同见 [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md)，Runner 与 self-hosted 边界见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。本文档描述当前实现与下一层收敛方向。

## 1. 核心模型

```text
Validate → Inspect → Plan → Execute → Triage → Review → Gate
```

现有实现已经具备其中的大部分基础：

```text
PR Policy
  Detect → Resolve → CI Evidence → Triage → Review → Gate

Task Dispatch
  Validate → Execute → Stage → Publication Gate → Publish

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
+ 统一执行编排
+ Runner Resolution
+ AI Review
+ Gate
+ Source / Release / Deploy 控制

业务仓
= 产品代码
+ 测试代码
+ 项目级 build / package / deploy 脚本
+ Execution Manifest
+ 最薄事件触发器（不包含治理策略和重执行）
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
- 当执行计划要求 CI 时，由 Action Worker checkout 目标不可变 head SHA，并在 Sandbox 执行项目 Manifest / 测试脚本，生成真实 CI Evidence；
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

项目测试代码继续与产品代码一起维护，但重执行统一收敛到 Action Worker Sandbox。

Action Worker 负责决定：

```text
本次是否需要 CI 证据
需要覆盖哪些通用测试类别
使用哪个 runner_profile
如何生成与 source SHA 绑定的 CI Evidence
最终是否满足 Gate
```

Action Worker 不复制项目测试实现，也不保存“某仓库必须执行某命令”的项目映射。项目命令与平台需求由受版本控制的 Execution Manifest / 项目脚本描述。

目标模式：

```text
repository event
→ Action Worker
→ checkout immutable source
→ Sandbox test / build / verify
→ CI Evidence
→ PR Governance
→ validate-merge bridge when required
```

当 `ci_required=false` 时，Action Worker 仍显式产生“无需执行 CI”的成功 Evidence；Evidence 不允许以缺失表示“不需要”。

业务仓如因 GitHub Ruleset 必须创建 `validate-merge` Check，只保留极轻 bridge，用于汇合中央 `CI Evidence` 与 `PR Governance`，不得再运行项目测试。

迁移期旧业务仓 CI Runner 属于待清理路径，只允许缩小，不允许作为新增仓库模板。

## 7. AI Agent Runtime

AI Agent 是 Action Worker 的通用动态能力单元，不等同于代码审查角色，也不绑定某个模型。

当前可以存在的 Agent 包括但不限于：

```text
triage
review
writing
```

未来可以继续增加：

```text
research
documentation
planner
critic
security
summary
...
```

新增 Agent 不应要求再创建新的模型变量、开关变量或项目专属配置层。

### 7.1 单一运行配置

所有 Agent 的启停与逻辑模型统一由 Action Worker Repository Variable 控制：

```text
AW_AI_AGENT_CONFIG
```

示例：

```json
{
  "schema_version": 1,
  "agents": {
    "triage": {
      "enabled": true,
      "model": "Code-Air"
    },
    "review": {
      "enabled": false,
      "model": "Code-Pro",
      "routes": {
        "release": { "model": "Code-Max" },
        "security": { "model": "Code-Ultra" },
        "architecture": { "model": "Code-Ultra" },
        "deep": { "model": "Code-Ultra" }
      }
    },
    "writing": {
      "enabled": true,
      "model": "Pro"
    }
  }
}
```

配置未提供时，所有可选 AI Agent 默认关闭。某个 Agent 的 `enabled=false` 时，该 Agent 不执行，也不得成为 Gate 的依赖。

`model` 是该 Agent 的默认逻辑模型；`routes` 只在一个 Agent 内部确实需要不同模型时覆盖默认值。这样 Review 可以按 code / workflow / release / security / architecture 等审计类型路由，Writing 也可以在未来按不同写作任务增加 route，而不需要再修改全局变量结构。

### 7.2 Policy 与模型分离

`AW_AI_AGENT_CONFIG` 只回答：

```text
Agent 是否启用
Agent 使用哪个逻辑模型
Agent 内部 route 使用哪个逻辑模型
```

确定性规则继续由 policy / rule 管理，例如：

```text
policies/review.json
policies/triage.json
rules/*.json
```

这些文件负责审查范围、阈值、超时、恢复预算和规则，不保存模型名称。模型选择和治理规则不得形成双权威。

### 7.3 PR 治理中的 Agent

PR Plan 先执行确定性判断。只有 `review` Agent 启用时，PR 才会进入 AI Review；`review.enabled=false` 时，PR 仍正常执行命名、CI Evidence、Change Record 和其他确定性 Gate，不因 AI 不可靠而失败。

`triage` 是独立 Agent。它只有在自身启用且 Review 确实需要时才参与路由；Triage 不可单独把一个被禁用的 Review 重新打开。

Review 内部当前可使用：

```text
code
workflow
release
security
architecture
deep
```

这些是 Review 的 route，不是全局 Agent 类型。未来新增 documentation、compliance、quality 等审计类型时，只扩展 Review route 与对应规则，不需要引入新的全局模型变量。

### 7.4 Writing 与其他 Agent

Writing 与 Review 平级，不是 Review 的附属能力。Task Dispatch 会把 Action Worker Repository Variables 作为运行配置提供给下游可信任务，因此 Writing Agent 也应读取同一个 `AW_AI_AGENT_CONFIG`，而不是维护第二套写作模型变量。

为避免每个 downstream bootstrap 重复解析 JSON，Action Worker 会在 Task Dispatch 运行时从 `AW_AI_AGENT_CONFIG` 派生只读环境变量。它们不是 GitHub Repository Variables，也不是第二套配置权威：

```text
AW_AI_AGENT_<AGENT>_MODEL
AW_AI_AGENT_<AGENT>_<ROUTE>_MODEL
```

例如：

```text
AW_AI_AGENT_WRITING_MODEL
AW_AI_AGENT_WRITING_MARKET_BRIEF_MODEL
AW_AI_AGENT_WRITING_PHARMA_BRIEF_MODEL
```

只有启用的 Agent 才会生成运行时变量；禁用 Agent 不生成模型值，因此引用方会 fail closed。若 Repository Variables 中手工定义与这些派生名称冲突的变量，Task Dispatch 必须拒绝执行，确保模型权威仍只有 `AW_AI_AGENT_CONFIG`。

后续 Planner、Critic、Research、Summary 等 Agent 也遵循同一原则：

```text
一个 Agent 运行配置入口
→ 每个 Agent 独立 enabled
→ 每个 Agent 独立逻辑模型
→ 必要时使用 Agent 内部 routes
→ Task Runtime 只消费派生模型值
```

### 7.5 AI Gateway 与 Review Engine

Action Worker 只选择逻辑模型，不维护 Provider、Key、节点或模型族 fallback。逻辑模型到 Provider 的实际容灾统一由 AI Gateway 负责。

当 Review Agent 启用时，OpenCodeReview 仍作为当前 Review Engine。Action Worker 不做无界整轮 OCR Review 重试；OpenCodeReview 负责单个 LLM 请求重试，AI Gateway 负责模型与 Provider fallback。若 OCR 已生成兼容 session，且最终失败仅来自 5xx、timeout、network 或 overload，Action Worker 按 `policies/review.json` 的有限恢复预算执行 `--resume`；认证、4xx 配置错误或恢复预算耗尽后仍 fail-closed。

Triage 与 Review 在 PR Governance 中继续共享受控 FIFO 队列，避免多个治理 run 同时占用 AI Gateway。该队列属于 PR AI 执行策略，不限制 Writing 或未来其他独立任务必须使用完全相同的队列。

### 7.6 Evidence 与 Gate

需要 CI 的 PR 会在 Review 前形成结构化 CI Evidence。AI Agent 可以读取 Evidence 辅助判断，但不得把 Evidence 中的文本当作指令。

AI Agent 是可选的动态判断层；最终 Gate 仍只相信可验证结果。任何 Agent 都不能修改权限边界、Secret 边界、CI Evidence 真实性要求或确定性 Gate 合同。

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

Task 使用 `AW_CONTROL_TOKEN` 获取受管私有仓固定 Commit；bootstrap 下载完成后，`AW_CONTROL_TOKEN`、`AW_ADMIN_TOKEN`、`AIG_ACCESS_KEY_AGENT` 与 `AW_DISPATCH_TOKEN` 等中央凭据会从业务执行环境中移除。Task 可以在 `RUNNER_TEMP/action-worker-publication` 暂存一个跨仓发布请求，但业务任务不持有目标仓写凭据。Action Worker 在任务成功后单独校验 `AW_REPOSITORY_POLICY`：源仓必须具有 `release-source`，目标仓必须具有 `release-target`；只有通过后才向中央发布步骤注入 `AW_CONTROL_TOKEN` 并写目标仓。

## 9. Source 与 Release

`validate-source-policy.yml` 继续作为当前迁移期 Source Gate 之一；长期 Source / CI 准入统一由中央 Execution Contract 生成可验证 Evidence。

Release 的目标链路为中央事件驱动：

```text
immutable source
  ↓
Action Worker central build / package
  ↓
release artifact + provenance
  ↓
handle-release-dispatch.yml
  ↓
validate-release-request.ts
  ↓
publish-release.ts
```

业务仓本地 source build workflow 只属于迁移兼容路径，不得用于新接入。

机器合同：

```text
contracts/release-dispatch.json
contracts/release-manifest.json
```

中央 Release Governance 验证：

```text
source repository allowlist
→ immutable source SHA
→ trusted central CI Evidence
→ successful artifact run
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

源仓只保存最薄事件入口所需凭据。目标模式要求 Artifact 由 Action Worker 中央执行产生，并用 provenance 将 artifact run 绑定到 source commit。迁移期仍接受的源仓本地 Artifact 只用于旧链路收口，不得成为新接入模式。Action Worker 使用中央凭据读取源仓和 artifact，并写分发目标。

Tag 固定为 `<release-key>-v<semver>`。不保留裸 `v<semver>` 兼容路径。

## 10. Release Build

Heavy release builds execute in Action Worker, not in business-repository runners.

```text
source repository manual intent
→ repository_dispatch: run-release-build
→ Action Worker source/default-HEAD/CI admission
→ central build matrix
→ central artifact package
→ release-provenance.json
→ repository_dispatch: run-release
→ Release Governance
→ external-vault Release
```

Project-specific build commands remain in the source repository as narrow scripts. Runner selection, Node/Python/Rust setup, build attestation, package-level SBOM generation, artifact aggregation, target repository, release manifest generation, provenance, publication, verification, and rollback are centrally governed.

The current central build matrix still contains project-specific entries for existing products. This is migration debt, not the target architecture. These entries must move toward project-owned Execution Manifests plus generic Action Worker executors.

Release targets and publication authority remain centrally governed; project build recipes must not be duplicated into a permanent repository-name mapping.

## 11. Tool Distribution

Third-party tool metadata remains authoritative in the distribution repository:

```text
external-vault/tools/catalog.json
→ tools/<tool>/tool.json
```

Action Worker owns scheduled synchronization and verification:

```text
tool catalog + metadata
→ upstream stable Release
→ upstream checksum / digest / license verification
→ release-manifest.json
→ release-provenance.json
→ Action Worker artifact
→ Release Governance
→ distribution repository Release
```

Business repositories do not run upstream download, checksum verification, packaging, or tool Release dispatch workflows. Tool metadata stays text-only in the distribution repository; executable payloads stay in GitHub Releases.

## 12. Deploy

Production deployment follows the same immutable-source boundary as Release Governance, but deploy execution does not publish a GitHub Release.

```text
business repository main
→ Central CI
→ trusted CI Evidence
→ immutable deploy request
→ Action Worker source gate
→ project deployment validation
→ production deploy
→ health verification
→ rollback on failure
```

Action Worker owns production credentials and runner-heavy deployment orchestration. The source repository owns only product code and project-specific deployment tooling. A deploy request cannot supply mutable refs, arbitrary repositories, CI conclusions, or deployment credentials.

The AI Gateway executor requires the current default-branch HEAD and a successful `CI Evidence` status whose target run belongs to Action Worker. `AIG_IS_DEPLOY_ENABLED=false` remains the emergency kill switch.

## 13. 目录

Action Worker 按职责分层。下面先列当前迁移期入口；其中带产品或具体部署目标语义的 workflow 属于待通用化对象，不构成长期命名模板：

```text
.github/workflows/
  validate-ci.yml
  central-ci-dispatch.yml
  handle-pr-dispatch.yml
  handle-release-dispatch.yml
  handle-task-dispatch.yml
  release-build.yml
  sync-tool-release.yml
  model-discovery.yml
  aig-scheduled-ci.yml
  aig-deploy.yml
  server-edge-deploy.yml
  deployment-readiness.yml
  validate-source-policy.yml
  validate-deploy-policy.yml
  validate-central-merge.yml
  apply-repo-settings.yml
  update-work-metrics.yml
  task-source-dispatch.yml

contracts/
  PR / Task / Release / Release Build / Deploy / Provenance contracts

policies/
  repository / execution / naming / review / release / deploy / CI policies

rules/
  architecture / code / release / security / workflow review rules

scripts/
  deterministic validation, dispatch, publication, synchronization, and governance controls

tests/
  contract, control-flow, runtime, release, deploy, CI, and regression tests

docs/
  architecture, governance, naming, changelog, development, and integration guides
```

禁止重新引入项目专属配置层，例如：

```text
projects/<repository-or-product>/
profiles/<repository-or-product>/
<repository-name>/
```

通用、仓库无关的 `executors/`、`runners/`、`adapters/` 等框架层可以在确有实现需要时引入，但必须由通用 Contract / Policy 驱动，不得演变成项目映射表。

项目专属 build / test / deploy 实现留在业务仓；Action Worker 只保存中央治理、通用执行框架和 Runner Resolution。业务仓脚本由 Action Worker checkout 后执行，不等于业务仓自己承担 Runner 重执行。

## 14. CI

Action Worker 自身只有一个总 CI：`validate-ci.yml`。

```text
naming
static
contracts
  ↓
validate-merge
```

contracts 同时验证架构治理边界，防止仓库随着功能扩展重新长出项目专属配置。

## 15. 版本

```text
main = 当前最新基线
```

Action Worker 只维护 `main` 这一条长期主线。
