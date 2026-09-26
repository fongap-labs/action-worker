# 架构治理

Action Worker 是 Fongap Labs 的 GitHub 自动化治理与执行平面。本文档定义长期边界；实现可以分阶段迁移，但不得继续扩大与本边界相反的实现。

统一执行合同见 [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md)，Runner 与 self-hosted 边界见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。

## 1. 核心边界

```text
Action Worker
= shared governance
+ execution authority
+ generic executors
+ runner resolution
+ AI Agent runtime
+ gate
+ provenance

Business repository
= source
+ tests
+ project scripts
+ project architecture
+ execution manifest
+ migration-only thin event bridge

Execution Ingress
= trusted repository event intake
+ Execution Request creation

Runner
= disposable compute backend
```

公开仓库与私有仓库使用同一执行架构。

长期入口也必须中央化：GitHub App、Webhook 或其他可信 Execution Ingress 直接把仓库事件转换为 Action Worker Execution Request。业务仓薄 dispatch 只是迁移兼容层，业务仓 Actions 是否有额度不得成为中央执行的依赖。

除迁移期最薄 dispatch 外，CI、test、build、AI Review、merge gate、release、deploy、task 与 scheduled job 等执行统一进入 Action Worker。业务仓本地 Check / status bridge 也属于待删除迁移路径。

业务仓拥有项目实现，但不拥有中央治理、中央 Secret、Runner 策略和最终执行权限。

## 2. 小内核，大框架

Action Worker Kernel 只保留稳定 Authority：

```text
Validate
→ Inspect
→ Plan
→ Authorize
→ Grant
→ Resolve Runner
→ Execute
→ Evidence / Provenance
→ Gate
```

大框架由通用 Executor 提供：

```text
CI
Build
Review
Task
Release
Deploy
Scheduled Job
Artifact
```

新增普通仓库、项目或 Runner 后端，不应要求修改 Kernel。

### 2.1 语言与运行时收敛

“小内核，大框架”是架构目标；语言不是架构目标。任何仓库或模块不得以“彻底 Rust 化”、彻底 TypeScript 化或其他单一语言化作为独立重构目标。

语言选择必须服从模块边界、性能、安全、可维护性、生态成熟度和开发效率。现有实现如果已经形成清晰、稳定且低成本的语言边界，不得仅为了统一语言而重写。

同时，语言种类不是越多越好。在以下条件全部满足时，应优先减少不必要的语言和运行时：

- 性能不下降；
- 安全边界不下降；
- 功能和兼容性不下降；
- 可维护性不下降；
- 不引入更重的运行时、构建链或部署负担。

一个责任只能有一个 Authority，一个能力只能有一套 Execution Contract。若两种语言在同一责任上维护重复实现、重复状态或重复协议，应优先消除职责重叠；是否统一语言是结果，不是目标。

允许长期存在的多语言边界必须能够回答“为什么这个边界需要这种语言”。不能回答时，默认视为待收敛维护债务。

## 3. Repository-agnostic

Action Worker 通用控制逻辑禁止出现：

```text
if repository == ...
if project == ...
if product == ...
```

也禁止使用等价的中央项目映射表保存项目专属 build / test / deploy recipe。

项目脚本和项目参数属于业务仓。Action Worker 通过标准 Execution Manifest 读取项目执行需求，再由通用 Executor 执行。

仓库白名单与 capability 属于运行配置，不进入源码。

## 4. Execution Request

调用方只提交任务身份和目标，不提交中央执行结论。

长期最小语义：

```text
schema_version
request_id
repository
source_sha
operation
```

调用方不得提交：

- 中央 Secret；
- Token；
- Gate 结论；
- 风险结论；
- 实际 Runner 名称；
- self-hosted label；
- 中央权限结论；
- 任意可绕过 Manifest 的动态命令。

项目测试、构建和部署命令可以存在于受版本控制的 Execution Manifest 或项目脚本中。

## 5. Execution Manifest

业务仓可以描述：

```text
operation
runner_profile
commands
matrix
artifacts
timeout
capability_requests
```

Manifest 是 Capability Request，不是 Capability Grant。

业务仓可以申请：

```text
source.read
artifact.write
release.publish
deployment.production
```

是否允许、对应什么 Secret、使用什么信任域和 Runner，由 Action Worker 决定。

## 6. Trust domains

### Control

允许：读取 GitHub 元数据、Validate / Inspect / Plan、AI Agent、Repository Policy、状态回写和受控 API 操作。

禁止直接执行不可信 PR 代码。

### Sandbox

允许 checkout 不可变 source SHA、执行项目 test / build / verify、生成 artifact 和 evidence。

禁止生产 Secret、中央管理 Token、非必要跨仓写权限和直接写生产环境。

### Privileged

仅用于明确需要生产凭据、私有网络或高权限资源的受控执行。Privileged 任务 fail closed，不得因为目标 Runner 不可用而自动降级到较低信任等级。

## 7. CI 与 PR Governance

项目测试属于产品规格，因此测试代码继续留在业务仓；执行位置统一收敛到 Action Worker：

```text
PR / push
→ thin dispatch
→ Action Worker
→ checkout immutable source
→ deterministic Security Gate
→ Sandbox CI / test / build
→ CI Evidence
→ deterministic PR Governance
→ validate-merge

                  └→ AI Review after gate
                     findings / suggestions only

merge
→ main update
→ Main Write Guard
→ trusted main SHA
```

业务仓不得为了“本地 CI”继续维护第二套重型 Runner 流程。

Source-owned CI control 也必须通过 PR 治理更新，禁止为了修 CI 而直接写 main。普通 PR 一律执行默认分支上的受信任 CI control；只有同仓且 GitHub `author_association` 为 `OWNER`、`MEMBER` 或 `COLLABORATOR` 的维护者 PR，在修改 `.github/execution-manifest.json`、`.github/scripts/central-ci.sh` 或 `.github/scripts/central-ci.ps1` 时，才允许以该 PR 的不可变 head SHA 作为候选 CI control 自验证。Fork 或非受信任作者修改 CI control 必须 fail closed。

候选 CI control 的执行环境仍属于 Sandbox：不得获得生产 Secret、中央管理 Token 或 privileged Runner 权限。候选 control 通过 Security Gate、Central CI 与 `validate-merge` 后才能进入默认分支。

中央 PR Intake 必须对同一 `repository + PR + head SHA` 幂等。发出 Governance 或 Dependency Repair dispatch 前，Intake 必须先发布短租约的 pending reservation；后续扫描在 reservation 租约有效或对应中央 run 仍在运行时不得重复派发。同一 head 的重复 dispatch 不得依赖“互相取消”实现幂等，因为它会制造假失败并浪费 CI 额度。

中央 Main CI 同样必须按不可变 `repository + head SHA` 幂等。相同 main SHA 的重复 `run-central-ci-ref` 请求不得互相取消；后发请求在已有该 SHA 的成功 `CI Evidence` 时必须直接复用证据并跳过重 CI。PR CI 仍允许新 head 取消旧 head，因为那属于 source identity 已变化的 stale work。

中央 CI 的 canonical commit status context 只有 `CI Evidence`。不得同时发布 `ci-evidence`、`ci_evidence` 或其他兼容别名；所有读取、等待、Release/Deploy gate 与审计必须引用同一标准名称。

公开仓的 GitHub Ruleset 直接要求 Action Worker 发布的中央 `validate-merge` status；业务仓不再启动本地 Runner 创建同名 Check。私有 Free 仓由 Main Write Guard 对同一中央状态做事后 provenance 强制。

## 8. Release

项目 build / package / deploy 脚本留在项目仓；重执行在 Action Worker。

```text
immutable source
→ central build
→ package / sign / SBOM / verify
→ release-manifest
→ release-provenance
→ Release Governance
→ publish
→ re-download verification
→ finalize or rollback
```

业务仓不持有目标分发仓写凭据。迁移期旧业务仓 artifact 路径只允许继续缩小，不得扩展为新的长期架构。

## 9. Deploy

生产部署使用同一 Execution Contract：

```text
immutable source
→ central source gate
→ project deploy validation
→ Runner Resolver
→ privileged execution when required
→ health verification
→ rollback
```

业务仓拥有部署脚本，不拥有生产 Secret 和 Runner 映射。需要私有网络、SSH、Tailscale 或其他生产访问时，可以解析到 self-hosted trusted Runner；业务仓仍只声明通用 runner profile / capability request。

## 10. Runner

业务仓不得直接指定 `ubuntu-24.04` 等实际镜像、`self-hosted`、Runner label、Runner group、hostname 或云实例名称。

业务仓只声明 `runner_profile`。Action Worker 的 Runner Resolver 决定实际后端：GitHub-hosted、self-hosted 或未来后端。

Self-hosted 是正式预留后端，不是项目特例。

## 11. AI Agent

AI Agent 是通用动态能力，不拥有权限边界，也不拥有 Merge Gate。

`AW_AI_AGENT_CONFIG` 是 Agent 启停和逻辑模型的单一运行配置。Policy / Rule 保存确定性规则，不保存第二套模型选择。

AI Review 的职责是审核、建议和发现问题。它必须位于确定性 PR Gate 结论之后执行，可以报告 critical / high / medium / low finding，但 finding 本身不能让 CI、PR Governance、validate-merge 或 Main Write Guard 失败；模型不可用、超时或 Review Engine 失败同样不得改变或延迟确定性 Gate 结论。

真正的门槛由可重复验证的 CI、PR Policy、Security Gate、Release / Deploy Policy 和 provenance 决定。Agent 可以参与 Plan、Triage、Review、Writing 等任务，但不能改变 Secret 边界、绕过 Capability Grant / CI Evidence、修改 Runner 信任等级或降低 Gate。

## 12. Main Write Guard

`validate-merge` 负责 main 之前的 Merge Authority；Main Write Guard 负责 main 更新之后的 provenance authority。

所有正式 Release、Deploy、Publication 和 privileged execution 都必须要求目标 source SHA 已获得 Main Write Guard success。仅仅位于 `main` 不构成可信来源。

Main Write Guard 的权威执行必须独立于业务仓 Actions：Action Worker 周期性审计 Repository Policy 中所有受管仓当前 main。业务仓 push dispatcher 只能作为可选实时加速，不属于安全前提。

详细规则见 [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md)。

## 13. Repository policy

仓库权限由单一 `AW_REPOSITORY_POLICY` 管理。

普通仓库接入应尽量只需要：

```text
register repository capability
→ configure thin dispatch
→ provide Execution Manifest / project scripts
→ run
```

如果新增普通仓库仍需要修改 Action Worker 核心脚本或增加项目专属 Policy，视为架构回退。

## 14. 目录边界

允许的长期结构：

```text
.github/workflows/   platform entrypoints
docs/                governance documentation
contracts/           machine contracts
policies/            deterministic policy
rules/               AI review rules
scripts/             generic execution/control logic
tests/               governance regression tests
```

禁止以仓库名或项目名建立中央配置目录。`runner_profile` 是合同概念，不代表允许创建项目专属 `profiles/` 配置层。

## 15. 迁移规则

当前代码尚未全部达到目标边界，因此允许迁移期旧实现存在，但必须遵守：

1. 新增能力不得继续扩大业务仓重执行；
2. 新增仓库默认走中央执行；
3. 旧业务仓 workflow 只允许缩小，不允许增加新的重步骤；
4. Action Worker 中项目专属 build/deploy 映射逐步迁移为 Manifest + 通用 Executor；
5. Runner 选择逐步统一进入 Runner Resolver；
6. 文档必须区分“当前实现”和“长期边界”。

## 16. 最短原则

> 业务仓描述要做什么；Action Worker 决定能不能做、怎么安全地做并统一执行；Runner 只提供计算；Gate 只相信与不可变 source 绑定的可验证结果。
