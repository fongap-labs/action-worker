# 接入指南

本文件定义受管仓库加入 Action Worker 统一执行平面所需的最低要求。公开仓库与私有仓库使用同一套合同。

## 1. 接入后的目标流程

```text
仓库事件
→ 中央接入 / 迁移期间的薄分发
→ Action Worker
→ 校验不可变源码
→ 解析执行清单
→ 授权能力
→ 解析 Runner
→ 执行
→ 证据 / provenance
→ 门禁 / 发布 / 部署 / 状态
```

业务仓库不复制中央治理，也不长期承担重型执行。

## 2. 业务仓库保留的内容

业务仓库保留：产品源码、无法从仓库外部运行的项目测试（见 [TEST_PACKS.md](TEST_PACKS.md) 第 6 节）、项目构建 / 打包 / 部署脚本、项目架构、执行清单，以及最薄的分发入口。

如果 GitHub 平台要求目标仓库自行创建必需检查，它可以保留一个极薄的检查桥接；该桥接不得运行产品测试，也不得持有中央密钥。

## 3. 执行请求

普通分发只提交任务身份与目标。长期的最小字段：

```text
schema_version
request_id
repository
source_sha
operation
```

对于 PR，请求可以携带 PR 编号；Action Worker 会重新读取真实的 base/head SHA 与 diff。

调用方不得提交密钥、令牌、实际 Runner、门禁结论或中央权限结论。

## 4. 执行清单

项目自身的执行需求，由版本受控的清单与项目脚本描述。

清单可以声明：

```text
operation
runner_profile
command
matrix
artifacts
timeout_minutes
capability_requests
```

清单不得声明：中央密钥、具体的 self-hosted Runner、Runner 标签、跨仓库写入令牌，或任何绕过门禁的开关。

详细合同见 [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md)。

## 5. CI 与 PR

目标模型：

```text
PR
→ 业务仓库的 Notify Action Worker 桥接（实时）/ Intake（兜底）
→ Security / Central CI / 确定性 PR 策略
→ CI Evidence
→ PR Governance / validate-merge
├→ 合并权限
└→ 门禁之后的 AI Review（仅供参考）
```

项目测试代码保留在业务仓库中（能从外部运行的测试放在测试包中），但 Action Worker 会检出不可变的源 SHA，并在沙箱中运行。

默认分支的 CI 以同样的方式进行对账：业务仓库的 `main` 有 push 时，桥接立即唤醒公开的 Action Worker 中的 Intake；Intake 检查每个受管仓库的当前 HEAD，当缺少 `CI Evidence` 时分发 `run-central-ci-ref`。桥接缺失时，Intake 也会在 Action Worker 自身的 push 或定时运行时补上，只是更慢。业务仓库不需要自己的 `ci.yml`。

如果仓库的 GitHub ruleset 要求检查运行必须来自目标仓库自身的 GitHub Actions，它可以保留一个极薄的 `validate-merge` 桥接。该桥接只连接 `CI Evidence` 与 `PR Governance`。

### 5.1 Linux CI 分片

默认情况下，Linux CI 是一个作业，从头到尾运行业务仓库的 `central-ci.sh`。在大型项目中，这一个作业会成为流水线中最慢的部分。业务仓库可以在 `.github/execution-manifest.json` 中把它拆分为多个并行的"分片"，使总耗时等于最慢分片的耗时，而不是所有部分耗时之和。

为此，请在 `ci` 操作中 id 为 `linux` 的作业上声明 `matrix.shard`，并把分片名作为第二个参数传给脚本：

```json
{
  "id": "linux",
  "runner_profile": "linux-standard",
  "command": ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}", "{matrix.shard}"],
  "matrix": { "shard": ["checks", "python", "rust"] },
  "timeout_minutes": 180,
  "capability_requests": ["source.read"]
}
```

规则：

- 分片名必须以小写字母开头，之后只能使用小写字母、数字和连字符，长度不超过 32 个字符；最多 8 个分片；`all` 为保留名称。
- `linux` 作业的 `matrix` 只允许键 `shard`。任何其他键、非法的分片名或超出上限的配置，都会使 CI 立即失败；不会静默跳过任何内容。
- 未声明 `matrix.shard` 的仓库（包括没有清单的仓库）不受影响：它仍是一个作业，脚本接收的参数与之前完全相同。
- 一旦声明，中央 CI 会为每个分片启动一个 Linux 作业，并以分片名作为第二个参数调用脚本。每个分片只负责自己的部分；只有所有分片都成功，`CI Evidence` 才为成功。
- Action Worker 只从可信的引用读取清单（默认分支，或维护者修改 CI 控制时的候选 head）。如何拆分分片属于业务仓库；Action Worker 不为任何项目保存分片表。

## 6. 安全扫描

业务仓库在 `.github/security-scan.json` 中声明安全扫描意图：CodeQL 语言、抽象的 `runner_profile`、构建模式，以及是否扫描 PR 和/或默认分支。Action Worker 从可信的 base / 默认 SHA 读取该清单，解析 Runner 并运行扫描。

PR 不能用自己的 head 修改安全扫描配置。中央 CodeQL 产生的 SARIF 不得作为公开的 `action-worker` 产物保存；结果直接从临时 Runner 回传到源仓库，然后销毁。

当前公开控制平面的 CodeQL 执行器只接受公开的源仓库。在日志抑制或私有安全执行器就绪之前，私有源仓库会失败即关闭；这是执行器的限制，不改变统一安全扫描合同。

定期扫描由公开的 Action Worker 中 Intake 的每周作业调度；业务仓库不需要定时运行的 CodeQL 工作流。

## 7. 依赖修复

依赖锁文件或生成清单之类的修复，由可信的依赖机器人触发，并回写到 PR 分支，使用源仓库自有的 `.github/dependency-repair.json`。

边界固定如下：

```text
可信的 PR 事实 + 基础清单
→ 无持久写入凭据的沙箱计算
→ 输出路径限制
→ 产物交接
→ 控制平面重新校验
→ 白名单分支写入
```

业务仓库只声明适配器、抽象的 `runner_profile`、可信的触发者、触发路径、允许的输出以及工具版本。Action Worker 不会按仓库名选择修复实现。

发布步骤不得运行任何目标仓库的项目命令；它只能把白名单内的生成输出写回同仓库的 PR 分支，并且该分支仍指向同一个 HEAD。

在删除旧的本地修复工作流之前，中央路径必须先在一个真实的机器人 PR 上成功运行，确保依赖修复不出现空窗期。

## 8. Runner

业务仓库只声明 `runner_profile`，绝不直接写明 GitHub 托管镜像、`self-hosted`、Runner 组、标签或主机名。

Action Worker 的 Runner 解析器会选择 GitHub 托管、self-hosted 或未来的其他后端。

详细规则见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。

## 9. 中央配置

Action Worker 仓库变量：

```text
AW_REPOSITORY_POLICY
AW_AI_AGENT_CONFIG
AI_GATEWAY_URL
```

Action Worker 密钥：

```text
AW_ADMIN_TOKEN
AW_CONTROL_TOKEN
AIG_ACCESS_KEY_AGENT
```

业务仓库只为桥接保留一个最小化的凭据 `AW_DISPATCH_TOKEN`；它只用于通知，中央 Intake 在桥接缺失时仍能完成治理与执行，所以它不是长期硬依赖。中央管理、跨仓库写入、AI Gateway 与生产凭据绝不能下沉到业务仓库。

`AW_CHECKOUT_TOKEN` 仅用于在沙箱和依赖修复计算作业中检出私有目标仓库。其权限只能是 `Contents: Read`，作用范围仅限受管的私有仓库，并且必须在过期前轮换。`AW_CONTROL_TOKEN` 用于中央读取、控制与状态治理。`AW_ADMIN_TOKEN` 仅用于可信控制步骤中的仓库级高权限写入，例如 Repository Settings / Rulesets，以及需要 Code Scanning 写权限的 SARIF 发布。高权限令牌绝不注入沙箱中的项目命令。

`AW_EXECUTION_TOKEN` 已被删除，不再配置。中央执行结合了现有的最小权限授权与 GitHub 原生的短期凭据。

## 10. Main Write Guard

业务仓库不承担 Main Write Guard 的权威执行。公开的 `action-worker` 审计 `AW_REPOSITORY_POLICY` 中每个受管仓库的当前 `main`，重新查询 GitHub，并证明源 SHA 来自合法的 PR 合并。证明在以下时机自动产生，不需要手动运行任何工作流：

- 业务仓库的 `main` 有 push 时，桥接唤醒 Intake，Intake 的 `Main write audit` 作业审计所有受管仓库；
- `Release App`、`Deploy Source Script`、`Task Source Dispatch` 在校验之前，先对源仓库运行同一个审计；
- 某个 `main` SHA 的中央 CI 通过之后，`Central CI Dispatch` 的 `Dispatch Central CI Follow-ups` 对该仓库运行审计；
- `action-worker` 自己的 `main` 有 push，或定时运行时。GitHub 对定时触发只做尽力而为，实际可能每隔数小时才运行一次，所以定时运行只是兜底。

### 10.1 业务仓库桥接

每个受管业务仓库只保留一个工作流 `.github/workflows/notify-action-worker.yml`，内容与 [`templates/bridge/notify-action-worker.yml`](../templates/bridge/notify-action-worker.yml) 逐字节一致，并配置仓库密钥 `AW_DISPATCH_TOKEN`。它只通知、不检出、不执行任何代码：

| 业务仓库中发生的事 | 桥接发送给 Action Worker 的事件 | 结果 |
|---|---|---|
| PR 打开、更新或重新打开 | `run-pr-governance` | PR 治理、中央 CI 与 `validate-merge` |
| PR 关闭（含合并） | `cancel-pr-work` | 取消该 PR 仍在进行的治理与中央 CI；未合并时也取消 AI Review |
| push 到 `main` | `run-intake` | 中央 CI、main 写入证明、变更任务与自动部署 |

由 Dependabot 触发的事件拿不到 Actions 密钥，由 Intake 处理。维护者批准一个等待批准的 PR 时，GitHub 不提供带密钥的事件，所以由下一次 Intake 运行发现批准；任何受管仓库的 `main` 有 push 都会立即启动这次运行。

桥接缺失、Actions 分钟数耗尽或被删除，都既不能产生可信的 main SHA，也不能削弱 Release / Deploy 的失败即关闭检查，只会让 Action Worker 发现变化变慢。它可以运行在 self-hosted Runner 上；见 [RUNNER_POLICY.md](RUNNER_POLICY.md) 第 11 节。

未经 Main Write Guard 证明的 SHA，不能用于 Release、Deploy、Publication 或特权执行。

详细规则见 [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md)。

## 11. 任务

任务项目保留在业务仓库中，但 Action Worker 拥有任务的入口。

业务仓库在 `.github/task-source.json` 中声明：

- `push: true`：默认分支上的变更由 Intake 自动发现并运行变更的项目；
- `schedules`：调度时段（cron）到项目的映射。

三种启动方式，结果相同：

| 方式 | 谁启动 | 说明 |
|---|---|---|
| 变更触发 | Intake 的 `Changed task projects` 作业 | 业务仓库 `main` 的 push 通过桥接立即唤醒 Intake。对于启用了 `push` 的仓库，如果当前 HEAD 还没有成功的 `Task Source` 状态，它会以第一个父提交作为 `before_sha` 分发一次变更项目的解析：运行期间写入 pending，成功时写入 success，失败时写入 failure，以便下一轮重试 |
| 定时 | Intake 的 `Scheduled task projects` 作业 | 每次 Intake 运行分发最近 20 分钟内到期的时段；每个时段只分发一次，由源提交上的 `Task Schedule/<project>` 状态记录。**补发已暂停**：错过的时段不会再补跑，直到查明 `run-task` 的失败原因。恢复时把 `intake.yml` 中的 `TASK_SOURCE_LOOKBACK_MINUTES` 改回 `"720"` |
| 手动 | 人从 Actions → `Task Source Dispatch` → Run workflow 启动 | 只填受管仓库与项目 |

手动启动时，`repository` 写成 `owner/name`（只写仓库名会报错，并在报错中给出对应的完整名称），`project` 是该仓库 `projects/` 下含有 `task.json` 的目录名（填错时报错会列出可选项）。工作流会先为该仓库 `main` 的 HEAD 申请中央 CI 并证明 main 写入，任务校验最多等待 20 分钟取得结果，不需要提前手动运行任何工作流。

中央仓库不得保留业务仓库或项目名称列表。

## 12. Release

```text
不可变源码
→ Action Worker 中央构建 / 打包
→ release-manifest + provenance
→ Release Governance
→ 目标发布
→ 重新下载校验
→ 完成 / 回滚
```

业务仓库保留项目的构建 / 打包脚本，并在 `.github/release.manifest.json` 中声明构建目标、产物以及抽象的 `runner_profile`。该 manifest 不包含版本。Action Worker 从不可变的源 SHA 读取并校验该 manifest，并通过中央 Runner 策略选择实际的 Runner。

项目 manifest 不得声明中央密钥、令牌，或具体的 GitHub / self-hosted Runner 标签。目标仓库的发布凭据始终保留在 Action Worker 中。

中央仓库不得保留按仓库或产品分组的 Release 构建矩阵。

发布版本即发布启动时人工输入的版本，且只有该版本。业务仓库不得保留约束该版本的规则：不得设置版本来源检查，不得做文件之间的一致性检查，也不得要求 CHANGELOG 中存在发布标题。项目构建脚本须声明必填的 `-Version` 参数，把该版本写入构建出的应用，并可校验构建产物确实携带该版本。

手动发布同样从 Action Worker 中的 `Release App` 工作流启动：由用户选择受管的 `source_repository` 并输入必填的稳定版本号；Action Worker 自行读取该仓库默认分支的当前 HEAD，先为它申请中央 CI 并证明 main 写入，再执行相同的源 / CI / provenance 检查，并最多等待 20 分钟取得 CI 结果。业务仓库无需为了"宣布发布"而启动自己的 Runner。

### 12.1 启动发布或部署的工作流

Release 与 Deploy 工作流按发布类型或部署适配器命名，绝不以产品或仓库命名。需要手动启动时，找到对应的行，在 Action Worker 的 Actions 标签页中打开该工作流，然后点击"Run workflow"。Action Worker 中只有 `Release App`、`Deploy Source Script` 与 `Task Source Dispatch` 有这个按钮，其余工作流都自动运行。

| 你想要 | 工作流 | 手动输入 | 自动启动方式 | 当前使用方 |
|---|---|---|---|---|
| 发布由源仓库构建的应用 | `Release App` (`release-app.yml`) | `source_repository`、`requested_version`（必填的稳定 SemVer） | `run-release-build` 分发事件 | delta、app-source |
| 发布从上游镜像而来的第三方工具 | `Release Tool` (`release-tool.yml`) | 无手动按钮 | 定时任务，每 6 小时一次，处理工具目录中的全部工具 | external-vault `tools/` |
| 部署某个源提交 | `Deploy Source Script` (`deploy-source-script.yml`) | `source_repository`、`source_sha`（可选；留空部署默认分支的当前 HEAD，否则是精确的 40 位 SHA） | 可信的 main 写入之后中央 CI 启动，且仓库的 `.github/deploy.json` 中 `automatic: true`；如果中央 CI 运行期间 `main` 之后只多了文档提交，则部署当前的 `main`，改动不会因为文档提交而漏部署 | ai-gateway（自动）、internal-vault（仅手动） |

`Handle Release Dispatch` 负责发布两类产物；以上工作流负责启动它，人不直接运行它。"当前使用方"是一个快照：每个仓库自身的 `.github/release.manifest.json` 或 `.github/deploy.json`，以及 `AW_REPOSITORY_POLICY`，才是权威来源，而不是本表。

### 12.2 启动前的检查与常见失败

启动 `Release App` 或 `Deploy Source Script` 之前不需要手动准备任何东西：工作流会先为源仓库默认分支的当前 HEAD 申请中央 CI 并证明 main 写入，并最多等待 20 分钟取得 CI 结果。你只需要保证：

1. 要发布或部署的改动已经通过 PR 合并进 `main`；
2. `source_repository` 写成 `owner/name`，且该仓库在 `AW_REPOSITORY_POLICY` 中具有对应的能力（发布需要 `release-source`，部署需要 `deploy`）；
3. 发布时 `requested_version` 写成稳定的 SemVer，例如 `1.2.3` 或 `v1.2.3`。

失败时先打开失败的步骤，日志里的 `::error::` 同时给出原因和下一步。报错信息按工程规范使用英文，下表是对应的中文说明：

| 日志中的报错 | 原因 | 怎么做 |
|---|---|---|
| `Invalid repository: x. Enter it as owner/name` | 只写了仓库名，没有写所有者 | 按提示写成 `owner/name` |
| `Repository is not allowed for <能力>` | 该仓库没有这项能力 | 报错末尾列出了具备该能力的仓库；确需新增时，由管理员修改 `AW_REPOSITORY_POLICY` |
| `Requested release version must be stable SemVer` | 版本带有预发布或构建后缀，或不是三段数字 | 改成 `1.2.3` 或 `v1.2.3` |
| `source_sha must be a full 40-character lowercase commit SHA` | 部署的 SHA 不是完整的 40 位小写十六进制 | 填完整的 SHA，或留空以部署当前 HEAD |
| `default HEAD moved` 或 `must be the current default-branch HEAD` | 你启动之后，默认分支又有了新提交 | 重新启动工作流，让它读取最新的 HEAD |
| `Source SHA failed CI Evidence: central CI failed for ...` | 中央 CI 在该提交上失败 | 打开报错里的链接查看失败的 job，通过 PR 修复并合并，等中央 CI 通过后重新启动 |
| `Source SHA has no successful Action Worker CI Evidence` | 等待 20 分钟后，中央 CI 仍没有结果（通常是 CI 仍在排队或运行） | 在 Actions → `Central CI Dispatch` 中找到该仓库的运行，等它通过后重新启动 |
| `was not produced by a successful Action Worker CI run` | 状态存在，但写入它的中央 CI 运行没有成功 | 打开报错里的运行，查看原因；必要时合并一个新提交，让中央 CI 重新运行 |
| `Source SHA has no successful Main Write Guard status` | 该 `main` SHA 还没有被证明来自合法的 PR 合并 | 几分钟后重新启动；仍然出现时，打开最新一次 `Intake` 运行的 `Main write audit` 作业查看原因 |
| `Source SHA failed Main Write Guard` 或 `not uniquely attributable to a merged pull request` | `main` 上有不是由单个 PR 合并产生的提交，例如直接 push | 通过一个新的 PR 合并一个提交（需要通过 `validate-merge`），让 `main` 的 HEAD 重新来自合法的合并 |

PR 治理最常见的失败：

| 日志中的报错 | 怎么做 |
|---|---|
| `PR title must use type(scope)!: summary format` | 把 PR 标题改成 `fix(deploy): retry the health check` 这样的格式；报错里列出了允许的类型 |
| `Invalid CHANGELOG entry` 或 `must use English engineering text` | CHANGELOG 条目写成 `- fix: summary`，摘要使用英文 |
| `Attribution check failed` | 提交的作者、提交者、trailer 或署名行出现了 AI 智能体名称。把作者与提交者改成你自己的 GitHub 账号，重写这些提交，然后强制推送分支 |

## 13. Deploy

```text
不可变源码
→ deploy 能力
→ 源仓库自有的 .github/deploy.json
→ Action Worker 源门禁
→ Runner 解析
→ 适配器
→ 受控部署
→ 健康检查
→ 回滚
```

业务仓库在 `.github/deploy.json` 中声明部署意图：`adapter`、是否自动部署、仅文档变更的策略、抽象的 `runner_profile`、环境标识符，以及当适配器需要时的源仓库自有入口点。

部署权限独立于普通的 PR 权限。只有在 `AW_REPOSITORY_POLICY` 中明确拥有 `deploy` 能力的仓库，Action Worker 才会解析其部署 manifest。

manifest 不得声明具体的 Runner 标签、主机、令牌或中央权限。源仓库自有的入口点在 `.github/deploy.secrets.required` / `.github/deploy.secrets.allowed` 中声明其最小密钥范围；只有在 `deploy` 能力、可信的 Main Write Guard 与特权 Runner 检查全部通过之后，Action Worker 才会注入该范围，并始终移除 Control 凭据。

`production-deploy` 是抽象的特权 Runner Profile；实际的 Runner 映射只由中央 Runner 策略决定。目前它可以映射到 GitHub 托管的 Runner；将来迁移到 self-hosted 时，业务仓库的 manifest 无需修改。

当部署需要生产网络、SSH、Tailscale 或其他受信任的网络时，特权任务失败即关闭，绝不降级到沙箱或控制 Runner。

## 14. 普通新仓库不应做的事

接入一个普通的新仓库，不应需要：

- 修改 Action Worker 的核心脚本；
- 添加基于仓库名或项目名的条件判断；
- 在 Action Worker 中创建项目专属的配置目录；
- 自行运行完整的 CI / 构建 / 审查 / 发布 / 部署；
- 自行选择 self-hosted Runner；
- 保存中央密钥；
- 复制中央策略。

如果似乎必须做其中之一，先检查是否缺少某项通用能力。

## 15. GitHub 平台边界

统一执行架构并不意味着每个 GitHub 套餐都具有相同的平台强制能力。

在 GitHub Free 套餐下，组织的私有仓库不支持 rulesets 或保护分支，因此这些仓库中的中央门禁属于当前套餐下的流程约束，而不是硬性的平台门禁。公开仓库仍可在平台允许的范围内使用受管的 rulesets。

平台功能的差异不得改变执行合同，也不得成为把重型执行搬回业务仓库的理由。

## 16. 迁移期

部分仓库仍保留旧的 CI / Release / Deploy 路径。它们是迁移债务。

迁移期间，旧路径只能缩减；新仓库与新能力直接使用统一执行合同。
