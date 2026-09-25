# 接入指引

本文档定义受管仓库接入 Action Worker 统一执行平面的最低要求。公开仓库和私有仓库使用同一合同。

## 1. 接入后的目标

```text
Repository event
→ central intake / migration thin dispatch
→ Action Worker
→ validate immutable source
→ resolve Execution Manifest
→ authorize capabilities
→ resolve Runner
→ execute
→ evidence / provenance
→ gate / release / deploy / status
```

业务仓不复制中央治理，也不承担长期重执行。

## 2. 业务仓保留什么

业务仓保留：产品源码、项目测试、项目 build / package / deploy 脚本、项目架构、Execution Manifest 和最薄 dispatch。

如果 GitHub 平台要求目标仓自身创建 Required Check，可以额外保留极轻 Check bridge；它不得运行产品测试或持有中央 Secret。

## 3. Execution Request

普通 dispatch 只提交任务身份和目标。长期最小字段：

```text
schema_version
request_id
repository
source_sha
operation
```

PR 场景可以提交 PR number，由 Action Worker 重新获取真实 base/head SHA 和 diff。

调用方不得提交 Secret、Token、实际 Runner、Gate 结论或中央权限结论。

## 4. Execution Manifest

项目自己的执行需求由版本控制的 Manifest / 项目脚本描述。

可以声明：

```text
operation
runner_profile
commands
matrix
artifacts
timeout
capability_requests
```

不得声明：中央 Secret、具体 self-hosted Runner、Runner labels、跨仓写 Token 或绕过 Gate 的开关。

详细合同见 [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md)。

## 5. CI / PR

目标模式：

```text
PR
→ Central PR Intake / optional migration thin dispatch
→ Security / Central CI / deterministic PR policy
→ CI Evidence
→ PR Governance / validate-merge
├→ merge authority
└→ AI Review after gate (advisory only)
```

项目测试代码留在业务仓，但由 Action Worker checkout 不可变 source SHA 后在 Sandbox 执行。

默认分支 CI 同样由公共 Action Worker 的 Central CI Intake 定期核对受管仓当前 HEAD；缺少 `CI Evidence` 时由中央主动派发 `run-central-ci-ref`。因此业务仓 `ci.yml` 只属于迁移期低延迟入口，不再是 main CI 的长期前置条件。

受 GitHub Ruleset 保护且要求 Check Run 来自目标仓 GitHub Actions 的仓库，可保留极轻 `validate-merge` bridge。它只汇合 `CI Evidence` 与 `PR Governance`。

## 6. Security Scan

业务仓通过 `.github/security-scan.json` 声明安全扫描意图，包括 CodeQL 语言、抽象 `runner_profile`、build mode，以及是否扫描 PR / default branch。Action Worker 从可信 base/default SHA 读取 manifest，统一解析 Runner 并执行扫描。

PR 不能用自己的 head 修改安全扫描配置。中央 CodeQL 生成的 SARIF 不允许保存为公开 `action-worker` artifact；结果必须在临时 Runner 内直接上传回源仓后销毁。

当前公开控制平面的 CodeQL executor 仅允许公开源码仓库。私有源码在没有完成日志抑制/私有安全执行器之前 fail closed；这属于 executor 能力限制，不改变统一 Security Scan Contract。

周期扫描由公共 Action Worker 的 Security Scan Intake 统一调度，不要求业务仓保留 scheduled CodeQL workflow。

## 7. Dependency repair

依赖锁文件、生成清单等“由受信依赖机器人触发、需要回写 PR 分支”的修复使用 source-owned `.github/dependency-repair.json`。

边界固定为：

```text
trusted PR facts + base manifest
→ sandbox compute without persistent write credentials
→ output-path confinement
→ artifact handoff
→ control-plane revalidation
→ allowlisted branch write
```

业务仓只声明 adapter、抽象 `runner_profile`、可信 actor、触发路径、允许输出和工具版本。Action Worker 不按仓库名选择修复实现。

发布步骤不得运行目标仓项目命令；它只允许把经过白名单校验的生成物回写到仍然指向同一 HEAD 的同仓 PR 分支。

在某个旧本地修复 workflow 被删除前，必须先用真实机器人 PR 验证中央路径成功，避免依赖修复断档。

## 8. Runner

业务仓只声明 `runner_profile`，不直接指定 GitHub-hosted 镜像、`self-hosted`、Runner group、labels 或主机名。

Action Worker Runner Resolver 统一选择 GitHub-hosted / self-hosted 或未来后端。

详细规则见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。

## 9. 中央配置

Action Worker Repository Variable：

```text
AW_REPOSITORY_POLICY
AW_AI_AGENT_CONFIG
AI_GATEWAY_URL
```

Action Worker Secret：

```text
AW_ADMIN_TOKEN
AW_CONTROL_TOKEN
AIG_ACCESS_KEY_AGENT
```

业务仓迁移期可以保留用于薄 dispatch 的最小凭据；中央 PR / CI Intake 生效后，这些凭据不再是治理与执行的长期硬依赖。中央管理、跨仓写、AI Gateway 和生产凭据不得下沉。

`AW_CONTROL_TOKEN` 用于中央读取、控制和状态治理；`AW_ADMIN_TOKEN` 仅用于可信控制步骤中的仓库级高权限写操作，例如 Repository Settings / Rulesets，以及需要 Code Scanning write 权限的 SARIF 发布。高权限 Token 不得注入 Sandbox 项目命令。

`AW_EXECUTION_TOKEN` 已删除，不再配置。中央执行使用最小权限的现有 Authority 与 GitHub 原生短期凭据组合。

## 10. Main Write Guard

业务仓不承担 Main Write Guard 的权威执行。公开 `action-worker` 定期审计 `AW_REPOSITORY_POLICY` 中所有受管仓当前 `main`，重新查询 GitHub 并证明 source SHA 来自合法 PR Merge。

业务仓可选保留极薄 main-push dispatcher 以缩短发现延迟，但缺少 dispatcher、Actions 额度不足或 dispatcher 被删除都不能产生可信 main SHA，也不能削弱 Release / Deploy 的 fail-closed 校验。

未经 Main Write Guard 证明的 SHA 不能用于 Release、Deploy、Publication 或 privileged execution。

详细规则见 [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md)。

## 11. Task

任务项目仍保留在业务仓，但 Task 入口由 Action Worker 统一拥有。

业务仓在 `.github/task-source.json` 声明：
- `push: true`：默认分支变化需要中央 Task Intake 自动发现；
- `schedules`：调度槽到 project 的映射。

Central Task Intake 定期扫描所有具有 `task` capability 的仓库，只读取真实默认分支 HEAD。对启用 `push` 的仓库，若当前 HEAD 尚无成功的 `Task Source` 状态，则以第一父提交作为 `before_sha` 派发 changed-project 解析；执行中写入 pending，成功写入 success，失败写入 failure 供下一轮重试。

手动任务直接从 Action Worker 的 `Handle Task Source Dispatch` workflow_dispatch 发起，只提交受管 repository 和 project。业务仓不再需要为了手动或 push 事件启动本地通知 Runner。

中央仓不得维护业务仓名或 project 名清单。

## 12. Release

```text
immutable source
→ Action Worker central build/package
→ release-manifest + provenance
→ Release Governance
→ target publish
→ re-download verification
→ finalize / rollback
```

业务仓保留项目 build / package 脚本，并在 `.github/release-build.json` 声明版本来源、构建目标、资产与抽象 `runner_profile`。Action Worker 从不可变 source SHA 读取并验证该 manifest，再通过中央 Runner Policy 选择实际 Runner。

项目 manifest 不得声明中央 Secret、Token 或具体 GitHub/self-hosted Runner label。目标仓发布凭据始终留在 Action Worker。

中央仓不得维护按 repository/product 分组的 Release Build 矩阵。

手动发布也从 Action Worker 的统一 Release Build workflow 发起：用户只选择受管 `source_repository` 和可选稳定版本号；Action Worker 自行读取该仓当前默认分支 HEAD，再执行同一 source/CI/provenance 校验。业务仓不需要为了“发一个 release 通知”启动自己的 Runner。

## 13. Deploy

```text
immutable source
→ deploy capability
→ source-owned .github/deploy.json
→ Action Worker source gate
→ Runner Resolver
→ adapter
→ controlled deploy
→ health verification
→ rollback
```

业务仓通过 `.github/deploy.json` 声明部署意图：`adapter`、是否自动部署、docs-only 策略、抽象 `runner_profile`、环境标识，以及 adapter 需要时的 source-owned entrypoint。

Deploy 与普通 PR 权限分开。只有在 `AW_REPOSITORY_POLICY` 显式拥有 `deploy` capability 的仓库，Action Worker 才允许解析 Deploy Manifest。

Manifest 不得声明 Secret 名称、具体 Runner label、host、Token 或中央权限。生产 Secret 和网络权限由中央 adapter / Capability Grant 决定。

`production-deploy` 是抽象 privileged Runner Profile，实际 Runner 映射只由中央 Runner Policy 决定。当前可以映射 GitHub-hosted；未来切到 self-hosted 时业务仓 Manifest 不变。

需要生产网络、SSH、Tailscale 或其他受信网络时，Privileged 任务必须 fail closed，不得自动降级到 sandbox/control Runner。

## 14. 普通新仓不应做什么

普通新仓接入不应要求：

- 修改 Action Worker 核心脚本；
- 增加仓库名 / 项目名条件分支；
- 在 Action Worker 建项目专属配置目录；
- 自己运行完整 CI / build / review / release / deploy；
- 自己选择 self-hosted Runner；
- 保存中央 Secret；
- 复制中央 Policy。

如果必须这样做，应先判断是否存在通用能力缺口。

## 15. GitHub 平台边界

统一执行架构不代表不同 GitHub 套餐拥有相同的平台强制能力。

GitHub Free 组织的私有仓库不支持 Ruleset 或 Protected Branch 强制保护，因此这些仓库中的中央 Gate 在当前套餐下属于流程约束，而不是 GitHub 平台硬门禁。公开仓库仍可在平台能力允许时使用受管 Ruleset。

平台能力差异不得改变 Execution Contract，也不得成为把重执行重新放回业务仓的理由。

## 16. 迁移期

当前部分仓库仍保留旧 CI / Release / Deploy 路径。它们属于迁移债务。

迁移期间：旧路径只允许缩小；新增仓库和新增能力直接采用统一 Execution Contract。
