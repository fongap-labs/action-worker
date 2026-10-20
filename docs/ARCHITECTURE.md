# 架构

Action Worker 是 Fongap Labs 的 GitHub 自动化控制平面。

长期边界由 [10-architecture-governance.md](10-architecture-governance.md) 定义。统一执行合同见 [09-execution-contract.md](09-execution-contract.md)，Runner 与 self-hosted 边界见 [08-runner-policy.md](08-runner-policy.md)。本文件描述当前的实现，以及下一步的收敛方向。

## 1. 核心模型

```text
Validate → Inspect → Plan → Execute → Gate → Advisory Review（仅供参考的审查）
```

当前实现已经提供了这一基础的大部分能力：

```text
PR Policy
  Detect → Resolve → Security / CI Evidence → 确定性门禁
                                      └→ 仅供参考的 AI Review

Task Dispatch
  Validate → Execute → Stage → Publication Gate → Publish

Source
  PR Gate → Merge → Main Write Guard → 可信的源码

Release
  Dispatch → Source Evidence → Artifact Verify → Target Gate → Publish

Deploy
  Source Gate → Deploy Gate → Execute

Self CI
  Validate → Gate
```

下一阶段不会增加项目专属的规则，而是把这些入口收敛到同一组通用合同上。

## 2. 中央边界

```text
Action Worker
= 通用规则
+ 调用方校验
+ 统一的执行编排
+ Runner 解析
+ AI Review
+ 门禁
+ Source / Release / Deploy 控制

业务仓库
= 产品代码
+ 测试代码
+ 项目级的构建 / 打包 / 部署脚本
+ 源仓库自有的清单（Execution / Release / Deploy）
+ 迁移期间仍需要的最薄事件触发器
```

Action Worker 不保留项目目录、不保留项目专属的测试映射，也不保留按仓库名分支的执行逻辑。

具体的仓库名称不进入源码。仓库权限从一个仓库变量 `AW_REPOSITORY_POLICY` 读取；一个仓库可以被授予 `pr`、`task`、`release-source` 与 `release-target` 能力。

## 3. PR

兜底入口是 `intake.yml` 的 `Pull requests` 作业。它扫描 `AW_REPOSITORY_POLICY` 中受管仓库的未关闭 PR，并为每个缺少结论的 PR 向 `handle-pr-dispatch.yml` 提交一个治理任务。业务仓库的 Actions 不是安全前提。

实时入口是业务仓库中唯一的桥接 `notify-action-worker.yml`（模板见 `templates/bridge/`）：PR 变化时发送 `run-pr-governance`，PR 关闭时发送 `cancel-pr-work`，`main` 有 push 时发送 `run-intake`。它不得保存命名规则、Agent、模型、门禁阈值、中央密钥或审查规则，也不得执行重型任务。

```text
受管仓库的 PR
  ↓
桥接 run-pr-governance（实时）/ Intake（兜底）
  ↓
handle-pr-dispatch
  ↓
Validate → Inspect → Plan → Security / CI / PR Gate
  ├→ AW_CONTROL_TOKEN → 目标 PR 上的确定性状态
  └→ 门禁通过后：repository_dispatch run-pr-review
        ↓
     handle-pr-review：AI Review → 仅供参考的摘要
```

AI Review 是独立的工作流 `handle-pr-review.yml`，只有在门禁通过后才由 `handle-pr-dispatch` 启动。这样设计有两个原因：门禁运行在得出门禁结论后即结束，AI 排队或审查永远不会拖住它；并且 AI 审查队列只包含真正在审查中的运行，绝不包含仍在等待 CI 的运行。

审查工作流不信任发送方声称的内容。它会重新读取当前的 PR head，并确认该 head 上带有 Action Worker 发布的 `PR Governance` 成功状态。以下情况会跳过审查：PR head 已经移动、PR 被关闭而未合并，或门禁未通过。它没有任何写入门禁状态的步骤。

审查通常比 CI 慢，PR 往往在审查结束之前就被合并。已合并的 PR 不会使审查失效：审查会完成，其评论仍会发布。只有被放弃的 PR（关闭而未合并）才会跳过审查。

PR Task 合同是 `contracts/pr-task.json`：

```text
schema_version
request_id
repository
pr_number
```

Action Worker 接收到任务后必须：

- 首先依据 `AW_REPOSITORY_POLICY` 中的 `pr` 能力校验目标仓库；
- 使用 `AW_CONTROL_TOKEN` 从 GitHub 重新读取 PR 的 base/head SHA、标题、状态与 diff；
- 在检出 `refs/pull/<n>/head` 之后，再与 GitHub 上的当前 PR 事实对齐一次。如果在分发与检出之间 PR 发生了变化，则与检出的提交和最新 PR API 同时一致的 base/head/标题，成为本次运行的事实，从而避免把同步窗口误判为永久失败；
- 只读取目标 PR，绝不执行 PR 提供的代码；
- 在分发中央 CI 之前检查 PR 作者（`scripts/pr-trust.ts`）：
  - 具有目标仓库写权限的作者（`author_association` 为 OWNER / MEMBER / COLLABORATOR）直接继续；
  - 来自同一公开仓库分支的 `dependabot[bot]` PR 同样直接继续（公开目标的沙箱不持有任何凭据）；
  - 来自其他作者的 PR（例如 fork 贡献者，或私有仓库中的 Dependabot）需要一位具有写权限的维护者对**当前 head 提交**给出 Approve 审查。等待期间，运行本身成功，但 `PR Governance` 与 `validate-merge` 会被写为 `failure`，描述固定为 `Awaiting maintainer approval of the current head commit`，PR 评论中列出操作步骤。Intake 的 `Pull requests` 作业识别该描述，并且在检测到对当前 head 的批准之前不会再次分发。GitHub 在批准时不提供带密钥的事件，所以批准由下一次 Intake 运行发现：任何受管仓库的 `main` 有 push 都会立即启动它，否则通常在一小时内（定时触发只是兜底，可能晚到数小时）。批准绑定到被审查的提交；作者之后的新推送需要新的批准；
  - `central-ci-dispatch.yml` 在执行任何操作之前会重复同样的检查，对不可信的 head 始终失败即关闭；
- 当执行计划需要 CI 时，在 Action Worker 中检出目标的不可变 head SHA，并在沙箱中运行项目清单 / 测试脚本，以产生真实的 CI Evidence；
- 首先由确定性的 PR / Security / CI 证据形成门禁结论，然后向目标 head 提交写入一个 `PR Governance` 状态；
- 只有在门禁结论形成之后，AI Review 才能读取 CI Evidence，并且将其视为不可信的执行证据；证据中的任何文本都绝不会被当作指令；
- 针对中央配置的、兼容 OpenAI 的 AI 端点运行 AI Review；它只发布发现与建议，从不参与门禁，也不延迟门禁。供应商、密钥池、回退与配额策略不属于 Action Worker 的权威；
- 使 AI Review 摘要独立于确定性门禁状态。

调用方不得提供 base SHA、head SHA、Agent、模型、风险或门禁结论。

## 4. 信任域

`policies/execution.json` 定义了两个稳定的边界。

### Control（控制域）

可以使用中央密钥（例如 AI Gateway 密钥），但不得执行 PR 代码。

### Sandbox（沙箱）

可以执行 PR 代码、进行构建与测试，但绝不接收中央密钥或部署凭据。

中央 CI 的沙箱作业位于 `central-ci-sandbox.yml`（一个可复用的工作流）。沙箱作业不直接引用任何中央密钥。

- 检出方式：公开目标使用本次运行的只读 `github.token`。只有私有目标，调用方才会传入 `checkout_token`，即只读的 `AW_CHECKOUT_TOKEN`（仅有 `Contents: Read` 权限，且仅限私有的受管仓库）。GitHub 在服务端评估该令牌，公开目标收到的值为空。
- 执行目标源码的作业（沙箱与依赖修复的计算作业）不得引用 `AW_CONTROL_TOKEN` 或 `AW_ADMIN_TOKEN`。
- 每个 `actions/checkout` 都使用 `persist-credentials: false`；唯一例外是需要提交的 `update-work-metrics.yml`。
- `security-scan-dispatch.yml` 的 CodeQL 作业不携带任何密钥，只生成 SARIF 产物；单独的 `publish` 作业持有 `AW_ADMIN_TOKEN` 并上传它。
- `tests/workflow-invariants.test.ts` 把这些边界转化为测试。

因此：

```text
计划可以动态变化
权限边界不能变化
```

## 5. 检测与计划

每个 PR 首先生成一份 Change Record：

```text
change_type = feat / fix / docs / style / refactor / perf /
              test / build / ci / chore / revert

attributes  = breaking / security / migration
```

`validate-change-record.ts` 根据 PR 标题与 CHANGELOG 构建并校验该记录。

`detect-pr-context.ts` 随后基于以下证据构建技术上下文：

```text
Git diff
仓库标记
CHANGELOG
```

`change_areas` 只说明变更触及了哪些技术区域（source / workflow / test / script 等），它不是变更类别。

`resolve-pr-plan.ts` 产生：

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
review_effort
route_severity
```

这些仍然是通用计划。它绝不能包含：

```text
if repository == delta
if repository == ai-gateway
...
```

未来的动态理解、历史基线与双 Agent 只能加强计划，不能改变这一边界。

## 6. 测试

`policies/checks.json` 与 `policies/tests.json` 描述通用的验证类别。

项目测试代码与产品代码保留在一起，但重型执行收敛到 Action Worker 的沙箱中。其中，能够从仓库外部运行的测试放在测试包中，其余测试留在产品代码中（见 [TEST_PACKS.md](TEST_PACKS.md)）。所有测试都在 Action Worker 的沙箱中运行。

Action Worker 决定：

```text
本次变更是否需要 CI Evidence
必须覆盖哪些通用测试类别
使用哪个 runner_profile
如何产生绑定到源 SHA 的 CI Evidence
门禁最终是否满足
```

Action Worker 不复制项目的测试实现，也不保留"仓库 X 必须运行命令 Y"形式的项目映射。项目命令与平台要求，由版本受控的执行清单与项目脚本描述。

目标模型：

```text
仓库事件
→ Action Worker
→ 检出不可变源码
→ 沙箱中的测试 / 构建 / 验证
→ CI Evidence
→ PR Governance
→ 必要时的 validate-merge 桥接
```

当 `ci_required=false` 时，Action Worker 仍然会写入一条明确的"无需 CI"成功证据。缺失证据绝不意味着"不需要"。

如果 GitHub ruleset 强制业务仓库创建 `validate-merge` 检查，它只保留一个极薄的桥接，用于连接中央的 `CI Evidence` 与 `PR Governance`；它不得再运行项目测试。

迁移期的旧业务仓库 CI Runner 是需要移除的路径。它们只能缩减，不能成为新仓库的模板。

## 7. AI Agent 运行时

AI Agent 是 Action Worker 的通用动态能力单元。它不同于代码审查角色，也不绑定到某个模型。

当前可能存在的 Agent 包括但不限于：

```text
triage（分诊）
review（审查）
writing（写作）
```

以后还可以增加：

```text
research（研究）
documentation（文档）
planner（规划）
critic（批判）
security（安全）
summary（摘要）
...
```

新增 Agent 不得要求新的模型变量、新的开关变量或项目专属的配置层。

### 7.1 唯一的运行时配置

Agent 的开关与逻辑模型的选择，由一个 Action Worker 仓库变量控制：

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

如果没有这份配置，所有可选的 AI Agent 都处于关闭状态。`enabled=false` 的 Agent 不会运行，也绝不能成为门禁的依赖。

`model` 是 Agent 的默认逻辑模型；只有当某个 Agent 确实需要不同模型时，`routes` 才会覆盖它。Review 可以按审计类型（code / workflow / release / security / architecture）路由，Writing 可以在以后为不同的写作任务增加路由，而无需改变全局变量的结构。

### 7.2 策略与模型分离

`AW_AI_AGENT_CONFIG` 只回答以下问题：

```text
某个 Agent 是否启用
该 Agent 使用哪个逻辑模型
该 Agent 内部的某条路由使用哪个逻辑模型
```

确定性规则保存在策略与规则中，例如：

```text
policies/review.json
policies/triage.json
rules/*.json
```

这些文件保存审查范围、优先级、超时、恢复预算与规则；其中不包含模型名称。模型选择与治理规则不得成为两个权威。

### 7.3 PR 治理中的 Agent

PR 计划首先做出确定性决定。只有当 `review` Agent 启用时，PR 才进入 AI Review。当 `review.enabled=false` 时，PR 仍然运行命名检查、CI Evidence、Change Record 与其他确定性门禁，并且绝不会因为 AI 不可靠而失败。

`triage` 是独立的 Agent。只有当它自身启用、并且确实需要审查时，它才参与路由；仅靠 triage 无法把已关闭的审查重新打开。

当前可用的审查路由：

```text
code
workflow
release
security
architecture
deep
```

这些是审查路由，而不是全局的 Agent 类型。未来新增的审计类型（例如文档、合规或质量）只扩展审查路由及其规则，不引入新的全局模型变量。

### 7.4 Writing 与其他 Agent

Writing 与 Review 是同级的 Agent，而不是 Review 的一部分。Task Dispatch 把 Action Worker 的仓库变量作为运行时配置提供给可信的下游任务，因此 Writing Agent 读取同一份 `AW_AI_AGENT_CONFIG`，而不是维护第二套写作模型变量。

为了让每个下游 bootstrap 都不必重复解析 JSON，Task Dispatch 运行时，Action Worker 会从 `AW_AI_AGENT_CONFIG` 派生只读的环境变量。它们不是 GitHub 仓库变量，也不是第二个配置权威：

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

运行时变量只为已启用的 Agent 存在。禁用的 Agent 不产生模型值，因此引用它的一切都会失败即关闭。如果手工定义的仓库变量与上述派生名称冲突，Task Dispatch 必须拒绝运行，从而保证 `AW_AI_AGENT_CONFIG` 是唯一的模型权威。

Planner、Critic、Research 与 Summary 等后续 Agent，遵循同样的原则：

```text
一个 Agent 运行时配置条目
→ 每个 Agent 独立启用
→ 每个 Agent 拥有自己的逻辑模型
→ 需要时，Agent 内部可以有路由
→ 任务运行时只消费派生的模型值
```

### 7.5 AI 端点与审查引擎

Action Worker 只选择逻辑模型，并调用中央配置的兼容 AI 端点。它不保存供应商、密钥池、节点或模型族的回退。该端点目前可以由 AI Gateway 提供，但该产品并非 Action Worker 的架构依赖。

当 Review Agent 启用时，OpenCodeReview 是当前的审查引擎。Action Worker 从不无限制地重试整轮 OCR 审查：OpenCodeReview 会重试单个 LLM 请求，供应商与模型回退由端点后端处理。如果 OCR 已经产生了兼容的会话，并且最终失败仅由 5xx、超时、网络或过载引起，Action Worker 会在 `policies/review.json` 规定的有限恢复预算内运行 `--resume`。当审查最终不可用时，只记录"仅供参考的审查不可用"；确定性的合并门禁不会改变。

在 PR Governance 中，Triage 与 Review 共享同一个受控的 FIFO 队列，以免多个治理运行同时占用中央 AI 端点。该队列属于 PR AI 执行策略；它不要求 Writing 或未来的独立任务使用同一队列。

### 7.6 证据与门禁

需要 CI 的 PR 首先形成结构化的 CI Evidence，并完成确定性门禁。AI Review 只能在门禁结论形成之后读取证据，作为审查的辅助材料，并且绝不能把证据中的文本当作指令。

AI Agent 是可选的动态审查层，而不是门禁层。AI 发现、模型故障、审查引擎故障或"AI 不可用"，本身都不能使合并门禁失败。最终门禁只信任可重复的 PR Policy、Security Gate、CI Evidence、Release / Deploy Policy 与 provenance。任何 Agent 都不得改变权限边界、密钥边界、CI Evidence 的真实性要求或确定性门禁合同。

## 8. Main Write Guard

PR 合并之后，`main` 的每一次更新都经过同一个 Main Write Guard。它会重新查询 GitHub 上的当前事实，并证明当前 main SHA 来自一个通过了确定性门禁的已合并 PR。

```text
validate-merge
→ 合并
→ main 更新
→ Main Write Guard
→ 可信的 main SHA
```

无法证明来源的 main SHA 失败即关闭：Release、Deploy、Publication 与特权执行都会被拒绝。

详细规则见 [07-main-write-guard.md](07-main-write-guard.md)。

## 9. Task Dispatch

现有的 `run-task` 保持稳定。

合同是 `contracts/task-dispatch.json`：

```text
schema_version
request_id
project
bootstrap_ref
```

`bootstrap_ref` 必须是完整的 40 位提交 SHA。

任务与 PR 遵循同一原则：

> 调用方提交目标；Action Worker 核实事实，并决定如何安全地执行。

任务使用 `AW_CONTROL_TOKEN` 获取受管私有仓库的固定提交。bootstrap 下载完成后，`AW_CONTROL_TOKEN`、`AW_ADMIN_TOKEN`、`AIG_ACCESS_KEY_AGENT` 与 `AW_DISPATCH_TOKEN` 等中央凭据会从业务执行环境中移除。随后使用 `exec` 启动 bootstrap，从而替换掉带有全部密钥启动的 shell，使任务不会与该进程并存。

- 当任务源仓库为私有仓库时，bootstrap 的输出会写入 Runner 的临时文件，而不是写入这个公开仓库的运行日志；日志只保留任务结果的摘要，该文件离开 Runner 时只以加密形式存在（见第 9.4 节）。
- 任务可以在 `RUNNER_TEMP/action-worker-publication` 中暂存一个跨仓库发布请求，但业务任务不持有目标仓库的写入凭据。
- 任务成功之后，Action Worker 会另行检查 `AW_REPOSITORY_POLICY`：源仓库需要 `release-source`，目标仓库需要 `release-target` 与 `pr`。只有在这些检查通过之后，`AW_CONTROL_TOKEN` 才会注入中央发布步骤，并通过 pull request 合并进目标仓库的 `main`（目标的 `main` 没有绕过项，并要求 PR 且 `validate-merge` 检查通过）。

### 9.1 任务源重新校验

`run-task` 的载荷只是调用方的声明。校验载荷之后，`handle-task-dispatch.yml` 的 `validate` 作业会调用 `scripts/validate-task-source.ts`，使接收方以与部署路径相同的规则重新核对事实：

- `bootstrap_ref` 必须等于目标仓库默认分支的当前 HEAD；引用过期时，以退出码 75 失败，下一次分发会处理新的 HEAD；
- 该提交必须带有通过重新校验的 `CI Evidence`。由 push 触发的任务可能先于 main 分支的 CI 到达，因此它最多等待约 20 分钟，只有在始终没有出现成功证据时才失败；
- 该提交必须通过 Main Write Guard（`assertTrustedMainWrite`）。

`handle-task-dispatch.yml` 的 `execute` 作业依赖 `validate`。重新校验失败时，任务永远不会启动，因此该提交声明的密钥范围也永远不会被解析。

`CI Evidence` 本身只是一个提交状态：任何能够写入提交状态的账户都可以设置以控制运行 URL 开头的 `target_url`。因此，PR 门禁（`wait-ci-evidence.ts`，以及 `dispatch-central-ci.ts` 判断能否跳过 CI 时）、部署准入、任务准入与 Main Write Guard 不会只检查前缀。它们会使用 `scripts/ci-evidence.ts` 中的 `hasVerifiedCiEvidence` 重新检查：

- 状态必须为 `success`，且其 `target_url` 必须指向控制仓库的一次运行；
- 该运行必须属于一个会发布此状态的工作流（`central-ci-dispatch.yml` 或 `handle-pr-dispatch.yml`），运行在默认分支上，并且已完成且成功；运行仍在收尾时，检查会短暂等待结论；
- 状态必须创建于该运行的时间窗口之内，因此状态不能指向一个无关的、较早的成功运行。

由于结论是针对整个运行做出的，`central-ci-dispatch.yml` 会在 `finalize`（写入 `CI Evidence`）之后，由一个单独的 `follow-up` 作业（`continue-on-error: true`）分发后续工作：安全扫描分发、Main Write audit 以及自动部署分发。后续步骤的失败不能使通过的 CI 运行变红，因此 PR 门禁永远不会因为某一个后续步骤而拒绝真实的 CI 结果。部署准入仍会自行检查 Main Write Guard。

GitHub 在这些提交状态中返回的 `creator` 字段为 `null`，因此检查不依赖创建状态的账户。发布路径（`validate-release-build-request.ts`、`publish-release.ts`、`sync-tool-release.ts`）仍使用较早的状态检查，之后会统一。

### 9.2 中央任务密钥列表

任务源仓库在 `projects/<project>/.secrets.required` 与 `.secrets.allowed` 中声明任务可以保留的密钥名称，但这些文件位于被执行方的提交中。`policies/task-secrets.json` 按仓库与项目记录其可声明名称的上限（`required` 与 `allowed` 的并集）；未列出的仓库或项目，上限为空。

当 `scripts/resolve-secret-scope.ts` 接收到策略路径、仓库与项目时，会把任务源声明的名称与该上限进行比较。`AW_TASK_SECRET_POLICY_MODE`（仓库变量，默认 `warn`）决定超出上限的名称会怎样处理：

- `warn`：任务继续运行，日志以 `::warning::` 列出超出的名称；
- `enforce`：运行以退出码 65 失败，任务不会启动。

在添加任务项目或其密钥之前，先更新 `policies/task-secrets.json`。确认 `warn` 日志中没有意外的超出项之后，再把 `AW_TASK_SECRET_POLICY_MODE` 设为 `enforce`。

### 9.3 密钥别名

源仓库声明其代码读取的密钥名称，例如 `CLOUDFLARE_API_TOKEN`。当同一个名称需要服务于多个账户时，一个已存储的密钥只能对应一个名称的一个值。因此，中央策略可以为任务项目或部署环境提供一个**别名**：在 `policies/task-secrets.json` 或 `policies/deploy-secrets.json` 中写入 `"aliases": { "CLOUDFLARE_API_TOKEN": "CLOUDFLARE_API_TOKEN_SECONDARY" }`。工作流随后在移除其他所有密钥之前，把声明的名称设置为别名中指定的已存储密钥的值；源码、其 `.secrets.required` / `.secrets.allowed` 列表及其入口点都不需要修改。

- 声明名称本身的已存储密钥绝不作为回退：别名名称对应的已存储密钥缺失时，必需项失败，可选项被移除，因为普通名称可能保存的是另一个账户的令牌。
- 别名的目标不得是保留名称，不得由源仓库声明，并且两个别名不能共享同一个目标。被别名的名称必须是策略为该项目或环境列出的名称。
- 当前的别名分配：`CLOUDFLARE_API_TOKEN_PRIMARY` 服务于 internal-vault 的任务 FongapBlog 与 FongapCDN，`CLOUDFLARE_API_TOKEN_SECONDARY` 服务于 ai-gateway 的部署。所有密钥，无论是否使用别名，都存储在 Action Worker 中。

### 9.4 私有任务状态与日志

本公开仓库的产物可以被任何已登录的 GitHub 用户下载。因此，对于私有任务源，任务状态（`task-state-<hash>`）与失败任务的日志（`task-log-<run>`）只以使用密钥 `AW_ARTIFACT_KEY` 加密的形式离开 Runner（AES-256-GCM，`scripts/task-state.ts`）。加密还会把每个文件绑定到其类型、仓库与项目，因此文件不能被替换到另一个任务中。

- 没有 `AW_ARTIFACT_KEY` 时，不上传任何私有内容：任务在没有先前状态的情况下运行，失败的日志留在 Runner 上。
- 任务永远不持有该密钥：`AW_` 前缀的名称在密钥范围中是保留的，并且如果密钥仍在其环境中，执行步骤会失败。
- 状态通过其产物名称查找，并且只接受 `main` 上 `handle-task-dispatch.yml` 成功运行产生的状态；解密之后会再次检查其 manifest。

读取失败的私有任务日志（由持有密钥文件的所有者执行，该密钥文件在创建密钥时保存）：

```bash
gh run download <run-id> -R fongap-labs/action-worker -n task-log-<run-id>-1 -D task-log
AW_ARTIFACT_KEY="$(cat ~/aw-artifact.key)" node scripts/task-state.ts open-log task-log/task-log.seal <owner/repository> <project> task.log
```

## 10. 源码与 Release

源码与 CI 准入使用中央执行合同所产生、并由 `hasVerifiedCiEvidence` 检查的可验证证据。

目标 Release 路径是中央事件驱动的：

```text
不可变源码
  ↓
Action Worker 中央构建 / 打包
  ↓
发布产物 + provenance
  ↓
handle-release-dispatch.yml
  ↓
validate-release-request.ts
  ↓
publish-release.ts
```

业务仓库中的本地源码构建工作流只是迁移期的兼容路径，新的接入不得使用它。

机器合同：

```text
contracts/release-dispatch.json
contracts/release-manifest.json
```

中央 Release Governance 会校验：

```text
源仓库白名单
→ 不可变源 SHA
→ 可信的中央 CI Evidence
→ 成功的产物运行
→ 精确的 Actions 产物
→ release-manifest.json
→ 声明的文件集合
→ SHA256
→ 目标仓库白名单
→ 限定范围内的 Tag / Release 冲突
→ 目标发布
→ 重新下载校验
→ 发布或回滚
```

源仓库保留源仓库自有的 release manifest 与项目级的构建 / 打包脚本，但不持有目标仓库的写入凭据。Action Worker 集中生成产物，并通过 provenance 把产物运行绑定到源提交。Action Worker 使用中央凭据读取源仓库、构建并校验产物，以及写入分发目标。

标签始终为 `<release-key>-v<semver>`。不存在针对裸 `v<semver>` 的兼容路径。

## 11. Release 构建

重型 Release 构建在 Action Worker 中执行，而不是在业务仓库的 Runner 上执行。

```text
release-build 入口
→ 源仓库 + 必填的请求版本
→ 解析当前不可变的默认分支源码
→ Action Worker 的源 / 默认 HEAD / CI 准入
→ 中央构建矩阵
→ 中央产物打包
→ release-provenance.json
→ repository_dispatch: run-release
→ Release Governance
→ external-vault Release
```

发布的版本是发布启动时输入的版本，且只有该版本。Action Worker 不从源仓库读取版本，也不会把输入版本与任何文件进行比较。构建脚本通过 `-Version` 接收它，并把它写入构建出的应用中。

项目专属的构建命令保留在源仓库中作为窄的脚本。Runner 选择、Node/Python/Rust 环境准备、构建证明、包级 SBOM 生成、产物汇总、目标仓库、release manifest 生成、provenance、发布、校验与回滚，都由中央统一治理。

构建矩阵从源仓库自有的 release manifest 解析而来。发布目标与发布权限保持中央治理；项目的构建配方不得被复制为永久的仓库名映射。

## 12. 工具分发

第三方工具的元数据，其权威保存在分发仓库中：

```text
external-vault/tools/catalog.json
→ tools/<tool>/tool.json
```

Action Worker 负责定时同步与校验：

```text
工具目录 + 元数据
→ 上游稳定 Release
→ 上游校验和 / 摘要 / 许可证校验
→ release-manifest.json
→ release-provenance.json
→ Action Worker 产物
→ Release Governance
→ 分发仓库的 Release
```

业务仓库不运行上游下载、校验和验证、打包或工具 Release 分发工作流。工具元数据在分发仓库中只以文本形式存在；可执行的载荷保存在 GitHub Releases 中。

Action Worker 执行的审查引擎在 `policies/review.json` 中通过 `version` 与 `sha256` 固定。安装器只有在二进制的摘要既等于固定值、又与 Release 校验和文件一致时才接受它，因此被替换的 Release 资产无法为自身背书。切换到新的引擎版本，需要在一次经过评审的变更中同时更新这两个字段。

## 13. Deploy

生产部署遵循与 Release Governance 相同的不可变源码边界，但部署执行不会发布 GitHub Release。

```text
业务仓库 main
→ 中央 CI
→ 可信的 CI Evidence
→ 不可变的部署请求
→ Action Worker 源门禁
→ 项目部署校验
→ 生产部署
→ 健康检查
→ 失败时回滚
```

Action Worker 拥有生产凭据，并负责需要 Runner 资源的重型部署编排。源仓库只拥有产品代码与项目专属的部署工具。部署请求不能提供可变的引用、任意仓库、CI 结论或部署凭据。

通用的 source-script 部署执行器是 `手动 · 部署服务` 工作流（`deploy-source-script.yml`），以其适配器命名。当仓库的 `.github/deploy.json` 中 `automatic: true` 时，中央 CI 会在可信的 main 写入之后启动它；人也可以通过指定仓库与精确 SHA 手动启动。它要求当前默认分支的 HEAD、可信的 Action Worker `CI Evidence`、Main Write Guard 成功、特权 Runner Profile，以及源仓库自有的部署 manifest。`AIG_IS_DEPLOY_ENABLED=false` 之类的产品专属紧急开关，仍保留在源仓库自有的部署入口点中。

执行器会取消声明范围之外的每一个密钥，然后使用 `exec` 启动入口点，从而替换掉带有全部密钥启动的 shell，使入口点不与其并存。

### 13.1 部署环境与密钥（中央权威）

部署 manifest（源仓库中的 `.github/deploy.json`）只*请求*一个环境。两个中央策略决定授予什么：

- `policies/deploy-environments.json` 按源仓库列出它可以使用的环境。`validate-deploy-source.ts` 在解析 manifest 之后立即检查其 `environment` 是否在列表中；未列出的仓库，或未对该仓库列出的环境，会在任何 Runner 启动之前以退出码 77 使部署失败。因此，仓库自身无法指定 `production`，也无法指定其他仓库的环境。
- `policies/deploy-secrets.json` 按仓库与环境列出源仓库可以在 `deploy.secrets.required` / `deploy.secrets.allowed` 中声明的密钥名称（其并集为上限），与任务的 `policies/task-secrets.json` 相同。`AW_DEPLOY_SECRET_POLICY_MODE`（仓库变量，默认 `warn`）决定超出上限的名称如何处理：`warn` 打印 `::warning::` 并继续，`enforce` 以退出码 65 失败，入口点永远不会启动。先修改策略文件，再修改源仓库的列表。成功完成一次演练部署之后，将该变量设为 `enforce`。

部署作业还会：使用只读的 `AW_CHECKOUT_TOKEN` 检出目标（绝不使用 `AW_CONTROL_TOKEN`）；请求 `resolve-secret-scope.ts` 拒绝任何声明列表中的控制平面凭据（`AW_CONTROL_TOKEN`、`AW_ADMIN_TOKEN`、`AW_DISPATCH_TOKEN`、`AW_CHECKOUT_TOKEN`、`GH_TOKEN`、`NODE_OPTIONS`）；如果其中任何一个仍在环境中，则在入口点启动之前失败。

每个使用 `AW_ADMIN_TOKEN` 的作业（`apply-repository-settings.yml`、`security-scan-dispatch.yml` 的 publish 作业）都在 `admin-ops` 环境中运行。两个环境（`production`、`admin-ops`）都把部署限制为 `main`；repository_dispatch 运行始终使用默认分支，而从其他分支发起的 `workflow_dispatch` 运行会被该环境拒绝。仓库级的密钥副本在环境副本验证完成之前保持不变；删除它们是一个单独的、由所有者手动执行的步骤。

## 14. 目录结构

Action Worker 按职责分层。当前的工作流按分类列于下方（分类规则见 [03-naming-conventions.md](03-naming-conventions.md) 第 8.3 节，由 `tests/workflow-classes.test.ts` 强制执行）。业务能力通过通用合同、清单与策略与之连接；没有任何长期工作流以产品命名：

```text
.github/workflows/
  # 入口：唯一可以从 Actions 标签页手动启动的工作流；自动化也通过 repository_dispatch 启动它们
  release-app.yml
  deploy-source-script.yml
  task-source-dispatch.yml

  # 对账：唯一的 Intake，扫描受管仓库并分发工作
  intake.yml

  # 事件处理：只由 repository_dispatch 启动
  handle-pr-dispatch.yml
  handle-pr-review.yml
  handle-release-dispatch.yml
  handle-task-dispatch.yml
  cancel-pr-work.yml
  central-ci-dispatch.yml
  dependency-repair-dispatch.yml
  security-scan-dispatch.yml

  # 维护：由 Action Worker 自身的 push、PR、定时或运行完成事件启动
  apply-repository-settings.yml
  main-write-guard.yml
  prune-stale-state.yml
  release-tool.yml
  update-work-metrics.yml
  validate-ci.yml

  # 可复用：只被其他工作流调用
  central-ci-sandbox.yml

contracts/
  PR / Task / Release / Release Build / Deploy / Provenance 合同

policies/
  repository / execution / naming / review / release / deploy / CI 策略

rules/
  architecture / code / release / security / workflow 审查规则

scripts/
  确定性的校验、分发、发布、同步与治理控制

tests/
  合同、控制流、运行时、发布、部署、CI 与回归测试

docs/
  架构、治理、命名、CHANGELOG、开发与接入指南
```

`tests/workflow-naming.test.ts` 检查工作流名称（见 [03-naming-conventions.md](03-naming-conventions.md) §2）；两个保留旧名称的文件（`handle-pr-dispatch.yml`、`handle-pr-review.yml`）在那里记录了原因。

禁止重新引入项目专属的配置层，例如：

```text
projects/<repository-or-product>/
profiles/<repository-or-product>/
<repository-name>/
```

当某个实现确实需要时，可以引入通用的、与仓库无关的框架层，例如 `executors/`、`runners/` 或 `adapters/`，但它们必须由通用合同与策略驱动，并且不能演变成项目映射表。

项目专属的构建 / 测试 / 部署实现保留在业务仓库中；Action Worker 只保留中央治理、通用执行框架与 Runner 解析。Action Worker 检出并执行的业务仓库脚本，并不意味着业务仓库自身在运行重型 Runner 执行。

## 15. CI

Action Worker 自身只有一个 CI：`validate-ci.yml`。

```text
命名
静态检查
合同
  ↓
validate-merge
```

合同同时验证架构治理的边界，因此随着功能增加，仓库不会重新长出项目专属的配置。

## 16. 版本

```text
main = 当前基线
```

Action Worker 只维护一条长期分支：`main`。
