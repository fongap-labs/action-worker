# 架构治理

Action Worker 是 Fongap Labs 的 GitHub 自动化治理与执行平面。本文件定义长期边界。实现可以分阶段迁移，但与这些边界相悖的现有实现，都不得继续扩张。

统一执行合同见 [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md)，Runner 与 self-hosted 边界见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。

## 1. 核心边界

```text
Action Worker
= 共用治理
+ 执行权威
+ 通用执行器
+ Runner 解析
+ AI Agent 运行时
+ 门禁
+ provenance

业务仓库
= 源码
+ 测试
+ 项目脚本
+ 项目架构
+ 执行清单
+ 迁移期间的薄事件桥

Execution Ingress（执行入口）
= 可信的仓库事件接入
+ 创建 Execution Request

Runner
= 可丢弃的计算后端
```

公开仓库与私有仓库使用相同的执行架构。

长期的入口也必须是中央化的：由 GitHub App、webhook 或其他可信的执行入口，把仓库事件直接转换为 Action Worker 的执行请求。业务仓库中的薄分发只是迁移期间的兼容层；业务仓库是否还有 Actions 分钟数，绝不能成为中央执行的前提。

除迁移期间最薄的分发之外，所有执行（CI、测试、构建、AI Review、合并门禁、Release、Deploy、任务与定时作业）都进入 Action Worker。业务仓库中的本地检查或状态桥接同样是需要移除的迁移路径。

业务仓库拥有项目实现，但不拥有中央治理、中央密钥、Runner 策略或最终执行权威。

## 2. 小内核，大框架

Action Worker 内核只保留稳定的权威：

```text
Validate（校验）
→ Inspect（检查）
→ Plan（计划）
→ Authorize（授权）
→ Grant（授予）
→ Resolve Runner（解析 Runner）
→ Execute（执行）
→ Evidence / Provenance（证据 / 来源证明）
→ Gate（门禁）
```

大框架由通用执行器提供：

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

新增一个普通仓库、项目或 Runner 后端，不得要求修改内核。

### 2.1 语言与运行时收敛

"小内核，大框架"是架构目标；语言本身不是目标。任何仓库或模块都不得把"全部改写为 Rust"、"全部改为 TypeScript"或其他单一语言的迁移作为自身的重构目标。

语言选择跟随模块边界、性能、安全、可维护性、生态成熟度与开发效率。已有、边界清晰、稳定且语言边界成本低的实现，不得仅为统一语言而重写。

但更多的语言并不更好。在以下条件全部成立时，应优先移除不需要的语言与运行时：

- 性能不下降；
- 安全边界不削弱；
- 功能与兼容性不下降；
- 可维护性不下降；
- 不引入更重的运行时、构建链或部署负担。

一项职责只能有一个权威，一项能力只能有一个执行合同。当两种语言为同一职责维护重复的实现、重复的状态或重复的协议时，先消除重叠，语言是否统一是结果，而不是目标。

每一个需要长期保留的多语言边界，都必须能回答"这个边界为什么需要这种语言"。无法回答的边界，视为需要收敛的维护债务。

## 3. 与仓库无关

通用的 Action Worker 控制逻辑绝不能包含：

```text
if repository == ...
if project == ...
if product == ...
```

同样禁止通过一张等价的中央项目映射表存放项目专属的构建、测试或部署配方。

项目脚本与项目参数属于业务仓库。Action Worker 从标准的执行清单中读取项目的执行需求，由通用执行器运行。

仓库白名单与能力是运行时配置，不进入源码。

## 4. 执行请求

调用方只提交任务身份与目标，绝不提交中央的执行结论。最小字段与语义由 `EXECUTION_CONTRACT.md` §5 定义。

调用方不得提交门禁结论、密钥、令牌、实际的 Runner 名称或任何可能绕过清单的动态命令。

项目的测试、构建与部署命令，可以存放在版本受控的执行清单或项目脚本中。

## 5. 执行清单（Execution Manifest）

业务仓库在 `.github/execution-manifest.json` 中描述自身的执行需求；字段、令牌替换与禁止声明由 `EXECUTION_CONTRACT.md` §6 定义。

清单是能力请求，而不是能力授予。能力名称、授予条件与密钥映射由 `EXECUTION_CONTRACT.md` §7 与 `policies/capabilities.json` 定义；请求是否被授予、使用哪个信任域与 Runner，均由 Action Worker 决定。

## 6. 信任域

### Control（控制域）

允许：读取 GitHub 元数据、执行 Validate / Inspect / Plan、运行 AI Agent、读取 Repository Policy、写回状态，以及受控的 API 操作。

禁止直接执行不可信的 PR 代码。

### Sandbox（沙箱）

允许：检出不可变的源 SHA，运行项目的测试 / 构建 / 验证，并产生产物与证据。

禁止：生产密钥、中央管理令牌、不必要的跨仓库写权限，以及直接写入生产环境。

### Privileged（特权域）

仅用于确实需要生产凭据、私有网络或高权限资源的受控执行。特权任务失败即关闭，绝不能因为目标 Runner 不可用而降级到较低的信任级别。

## 7. CI 与 PR 治理

项目测试是产品规格的一部分。能够从仓库外部运行的测试，保存在 Action Worker 的测试包中（[TEST_PACKS.md](TEST_PACKS.md)）；其余测试保留在业务仓库中。所有测试都在 Action Worker 的沙箱中运行：

```text
PR / push
→ 薄分发
→ Action Worker
→ 检出不可变源码
→ 确定性 Security Gate
→ Sandbox CI / test / build
→ CI Evidence
→ 确定性 PR Governance
→ validate-merge
                  └→ 门禁之后执行 AI Review
                     仅产生发现与建议
merge
→ main 更新
→ Main Write Guard
→ 可信的 main SHA
```

业务仓库不得保留第二套重型 Runner 流程用作"本地 CI"。

源仓库自有的 CI 控制只能通过 PR 治理更新；为修复 CI 而直接写入 `main` 是禁止的。

- 普通 PR 始终运行默认分支上的可信 CI 控制。
- 只有同时满足以下条件的维护者 PR，才可以使用自己不可变的 head SHA 作为候选 CI 控制进行自验证：来自同一仓库；GitHub `author_association` 为 `OWNER`、`MEMBER` 或 `COLLABORATOR`；修改了 `.github/execution-manifest.json`、`.github/scripts/central-ci.sh` 或 `.github/scripts/central-ci.ps1`。
- 来自 fork 或不可信作者、且修改了 CI 控制的 PR，失败即关闭。

候选 CI 控制仍在沙箱中运行：它不接收生产密钥、中央管理令牌或特权 Runner。候选控制只有在通过 Security Gate、Central CI 与 `validate-merge` 之后，才会进入默认分支。

Intake 的 PR 对账对于相同的 `repository + PR + head SHA` 必须幂等。在发送 Governance 或 Dependency Repair 分发之前，Intake 先发布一个带有短租约的待处理预留；只要租约仍有效或对应的中央运行仍在进行，后续扫描不得再次分发。同一 head 的重复分发，不能依赖运行之间互相取消来保证幂等，因为这会产生误报失败并浪费 CI 分钟数。

重新分发只由 PR head 的状态触发，不由默认分支（控制版本）的移动触发：head 已有完整的 `PR Governance`、`CI Evidence` 与 `validate-merge` 结论时，即使 main 已前进，Intake 也不再为该 head 分发，因为这会取消同一 PR 正在运行的中央 CI。待处理预留所指向的运行若已被取消，同样不再分发；只有租约已过期、且对应运行已结束但没有留下结论的预留，才会被重新分发。

中央 main 分支 CI 对不可变的 `repository + head SHA` 同样必须幂等。Intake 的 main CI 对账（以及 Release、Deploy、Task 入口为源仓库申请 CI 时使用的同一脚本）在发送 `run-central-ci-ref` 之前，先发布一个 `CI Evidence=pending` 的预留并带有短租约；只要租约仍有效或对应的中央运行仍在进行，不得再次分发。针对同一 main SHA 的重复请求，不得互相取消；如果后来的请求发现该 SHA 已有成功的 `CI Evidence`，则复用该证据并跳过重型 CI。PR CI 仍允许新 head 取消旧 head，因为旧 head 是源身份已经改变的过期工作。

中央 CI 唯一的规范提交状态上下文是 `CI Evidence`。不得在它旁边发布 `ci-evidence` 或 `ci_evidence` 之类的别名；每一次读取、等待、Release/Deploy 门禁与审计，都引用同一个标准名称。

公开仓库的 GitHub ruleset 直接要求 Action Worker 发布的中央 `validate-merge` 状态；业务仓库不再为同名检查启动本地 Runner。对于 Free 套餐的私有仓库，Main Write Guard 事后将同一中央状态作为来源证明执行。

## 8. Release

项目的构建、打包与部署脚本保留在项目仓库中；重型执行发生在 Action Worker。

```text
不可变源码
→ 中央构建
→ 打包 / 签名 / SBOM / 校验
→ release-manifest
→ release-provenance
→ Release Governance
→ 发布
→ 重新下载校验
→ 完成或回滚
```

业务仓库不持有目标分发仓库的写入凭据。迁移期遗留的业务仓库产物路径只能缩减，不得发展为新的长期架构。

## 9. Deploy

生产部署使用同一执行合同：

```text
不可变源码
→ 中央源门禁
→ 项目部署校验
→ Runner 解析
→ 需要时执行特权任务
→ 健康检查
→ 回滚
```

业务仓库拥有自己的部署脚本，但不拥有生产密钥或 Runner 映射。当部署需要私有网络、SSH、Tailscale 或其他生产访问时，它可以解析为受信任的 self-hosted Runner；业务仓库仍只声明通用的 Runner Profile 或能力请求。

## 10. Runner

业务仓库不得写明实际的镜像（如 `ubuntu-24.04`）、`self-hosted`、Runner 标签、Runner 组、主机名或云实例名。

业务仓库只声明 `runner_profile`。由 Action Worker 的 Runner 解析器决定实际后端：GitHub 托管、self-hosted 或未来的其他后端。

Self-hosted 是正式保留的后端，而不是某个项目的特例。

## 11. AI Agent

AI Agent 是一种通用的动态能力。它不拥有权限边界，也不拥有合并门禁。

`AW_AI_AGENT_CONFIG` 是唯一的运行时配置，用于开关 Agent 并指定其逻辑模型。策略与规则只存放确定性规则，不存放第二份模型选择。

AI Review 负责审查、建议与发现问题。它必须在确定性 PR 门禁结论之后运行。它可以报告严重 / 高 / 中 / 低级别的发现，但单个发现本身永远不能导致 CI、PR Governance、validate-merge 或 Main Write Guard 失败；模型不可用、超时或审查引擎故障，同样不得改变或延迟确定性门禁的结论。

真正的门禁阈值由可重复的 CI、PR Policy、Security Gate、Release / Deploy Policy 与 provenance 决定。Agent 可以参与规划、分诊、审查、写作等任务，但不能改变密钥边界、绕过能力授予或 CI Evidence、改变 Runner 信任级别，或降低门禁。

## 12. Main Write Guard

`validate-merge` 是 `main` 之前的合并权限；Main Write Guard 是 `main` 更新之后的来源证明权限。

每一次正式的 Release、Deploy、Publication 与特权执行，都要求目标源 SHA 拥有 Main Write Guard 的成功结果。仅仅位于 `main` 上，不构成可信来源。

Main Write Guard 的权威执行不得依赖业务仓库的 Actions：Action Worker 定期审计 Repository Policy 中每个受管仓库的当前 `main`。业务仓库中的 push 分发器只能作为可选的实时加速手段，不是安全前提。

详细规则见 [07_MAIN_WRITE_GUARD.md](07_MAIN_WRITE_GUARD.md)。

## 13. 仓库策略

仓库权限由单一的 `AW_REPOSITORY_POLICY` 管理。

接入一个普通仓库只需要：

```text
注册仓库能力
→ 配置薄分发
→ 提供执行清单 / 项目脚本
→ 运行
```

如果接入普通仓库仍然需要修改 Action Worker 的核心脚本或添加项目专属策略，就属于架构退化。

## 14. 目录边界

允许的长期结构：

```text
.github/workflows/   平台入口
docs/                治理文档
contracts/           机器合同
policies/            确定性策略
rules/               AI 审查规则
scripts/             通用执行 / 控制逻辑
tests/               治理回归测试
```

禁止使用以仓库或项目名命名的中央配置目录。`runner_profile` 是合同概念；它不允许存在项目专属的 `profiles/` 配置层。

## 15. 迁移规则

迁移期旧实现的完整规则（新能力不得增加重型执行、新仓库默认中央执行、旧工作流只能缩减、项目专属映射逐步迁移到清单与通用执行器）见 `EXECUTION_CONTRACT.md` §11。本文件补充：

- Runner 选择逐步收敛到 Runner 解析器；
- 文档必须区分"当前实现"与"长期边界"。

## 16. 最短原则

> 业务仓库描述要做什么；Action Worker 决定是否允许、以何种方式安全地执行，并负责执行；Runner 只提供计算；门禁只信任绑定在不可变源码上的、可验证的结果。
