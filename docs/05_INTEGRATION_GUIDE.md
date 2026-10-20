# 接入指南

本文件定义受管仓库加入 Action Worker 统一执行平面所需的**最低要求**。公开仓库与私有仓库使用同一套合同。

详细运维操作（发布/部署手动步骤、错误码表、多产品布局、定时部署、跟随型产品）见 `06_RELEASE_DEPLOY_GUIDE.md`。
Main Write Guard 完整规则见 `07_MAIN_WRITE_GUARD.md`。

---

## 1. 接入后的目标流程

```
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

业务仓库**不复制**中央治理，**不长期承担**重型执行。

---

## 2. 业务仓库保留的内容

- 产品源码
- 无法从仓库外部运行的项目测试（可外部运行的测试放入测试包，见 `TEST_PACKS.md` §6）
- 项目构建 / 打包 / 部署脚本
- 项目架构
- 执行清单（`.github/execution-manifest.json`）
- **最薄的分发入口**（见 §3）

如果 GitHub 平台要求目标仓库自行创建必需检查，可保留一个**极薄的检查桥接**；该桥接不得运行产品测试，也不得持有中央密钥。

---

## 3. 执行请求（分发载荷）

普通分发只提交任务身份与目标。长期最小字段：

```
schema_version
request_id
repository
source_sha
operation
```

对于 PR，请求可携带 PR 编号；Action Worker 会重新读取真实的 base/head SHA 与 diff。

**调用方不得提交**：密钥、令牌、实际 Runner、门禁结论、中央权限结论。

---

## 4. 执行清单（`.github/execution-manifest.json`）

项目自身的执行需求，由版本受控的清单与项目脚本描述。

清单可声明：

```
operation
runner_profile
command
matrix
artifacts
timeout_minutes
capability_requests
```

清单**不得声明**：中央密钥、具体 self-hosted Runner、Runner 标签、跨仓库写入令牌、绕过门禁的开关。

详细合同见 `EXECUTION_CONTRACT.md`。

### 4.1 Linux CI 分片（可选）

默认 Linux CI 为单作业。大型项目可在 `ci` 操作中声明 `matrix.shard` 拆分为并行分片：

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
- 分片名：小写字母开头，仅小写字母/数字/连字符，≤32 字符，最多 8 个，`all` 保留
- `matrix` 仅允许键 `shard`；非法配置即时失败
- 未声明 `matrix.shard` 的仓库不受影响（仍为单作业）
- 仅所有分片成功，`CI Evidence` 才为成功

---

## 5. CI 与 PR

目标模型：

```
PR
→ 业务仓库的 Notify Action Worker 桥接（实时）/ Intake（兜底）
→ Security / Central CI / 确定性 PR 策略
→ CI Evidence
→ PR Governance / validate-merge
├→ 合并权限
└→ 门禁之后的 AI Review（仅供参考）
```

- 项目测试代码保留在业务仓库；Action Worker 检出不可变源 SHA，在沙箱中运行
- 默认分支 CI 同理：`main` push 时桥接唤醒 Intake；Intake 检查每个受管仓库当前 HEAD，缺少 `CI Evidence` 时分发 `run-central-ci-ref`
- 桥接缺失时，Intake 也会在 Action Worker 自身 push 或定时运行时补上（较慢）
- 业务仓库**不需要**自己的 `ci.yml`
- 若仓库 ruleset 要求检查来自目标仓库自身 Actions，可保留极薄的 `validate-merge` 桥接，仅连接 `CI Evidence` 与 `PR Governance`

---

## 6. 安全扫描

业务仓库在 `.github/security-scan.json` 声明意图：CodeQL 语言、抽象 `runner_profile`、构建模式、是否扫描 PR/默认分支。Action Worker 从可信 base/默认 SHA 读取清单，解析 Runner 并运行扫描。

- PR **不能**用自己的 head 修改安全扫描配置
- 中央 CodeQL 产生的 SARIF 不得作为公开 `action-worker` 产物保存；结果直接回传源仓库后销毁
- 当前公开控制平面 CodeQL 执行器只接受公开源仓库；私有源仓库在日志抑制/私有执行器就绪前失败即关闭
- 定期扫描由公开 Action Worker 中 Intake 周作业调度；业务仓库不需要定时代码扫描工作流

---

## 7. 依赖修复

依赖锁文件/生成清单修复，由可信依赖机器人触发，回写 PR 分支，使用源仓库自有 `.github/dependency-repair.json`。

边界固定：

```
可信的 PR 事实 + 基础清单
→ 无持久写入凭据的沙箱计算
→ 输出路径限制
→ 产物交接
→ 控制平面重新校验
→ 白名单分支写入
```

业务仓库只声明：适配器、抽象 `runner_profile`、可信触发者、触发路径、允许输出、工具版本。Action Worker 不按仓库名选择修复实现。

发布步骤不得运行目标仓库项目命令；只把白名单内生成输出写回同仓库 PR 分支，分支仍指向同一 HEAD。

删除旧本地修复工作流前，中央路径必须先在真实机器人 PR 上成功运行，确保无空窗期。

---

## 8. Runner

业务仓库**只声明** `runner_profile`，**绝不**直接写明：GitHub 托管镜像、`self-hosted`、Runner 组、标签、主机名。

Action Worker 的 Runner 解析器选择 GitHub 托管、self-hosted 或未来后端。

详细规则见 `RUNNER_POLICY.md`。

---

## 9. 中央配置（仅供参考，业务仓库无需配置）

Action Worker 仓库变量：
```
AW_REPOSITORY_POLICY
AW_AI_AGENT_CONFIG
AI_GATEWAY_URL
```

Action Worker 密钥：
```
AW_ADMIN_TOKEN
AW_CONTROL_TOKEN
AIG_ACCESS_KEY_AGENT
```

业务仓库只为桥接保留一个最小化凭据 `AW_DISPATCH_TOKEN`（仅用于通知）。中央 Intake 在桥接缺失时仍能完成治理与执行，所以它不是长期硬依赖。**中央管理、跨仓库写入、AI Gateway 与生产凭据绝不能下沉到业务仓库。**

`AW_CHECKOUT_TOKEN`：仅用于沙箱与依赖修复计算作业检出私有目标仓库。权限仅 `Contents: Read`，仅限受管私有仓库，过期前轮换。
`AW_CONTROL_TOKEN`：中央读取、控制与状态治理。
`AW_ADMIN_TOKEN`：仅用于可信控制步骤的仓库级高权限写入（Repository Settings / Rulesets、SARIF 发布所需 Code Scanning 写权限）。高权限令牌绝不注入沙箱项目命令。

`AW_EXECUTION_TOKEN` 已被删除，不再配置。中央执行结合了现有的最小权限授权与 GitHub 原生的短期凭据。

---

## 10. Main Write Guard 概览

业务仓库**不承担** Main Write Guard 权威执行。公开 `action-worker` 审计 `AW_REPOSITORY_POLICY` 中每个受管仓库的当前 `main`，重新查询 GitHub，证明源 SHA 来自合法 PR 合并。

证明自动产生，触发时机：
- 业务仓库 `main` push → 桥接唤醒 Intake → `Main write audit` 审计所有受管仓库
- `手动 · 发布应用` / `手动 · 部署服务` / `手动 · 派发任务` 校验前，先对源仓库运行同一审计
- 某 `main` SHA 中央 CI 通过后 → `自动 · CI 分发` 的 `Dispatch Central CI Follow-ups` 对该仓库审计
- `action-worker` 自身 `main` push 或定时运行（GitHub 定时仅尽力而为，实际间隔数小时，定时为兜底）

**未经 Main Write Guard 证明的 SHA，不能用于 Release/Deploy/Publication/特权执行。**

完整规则见 `07_MAIN_WRITE_GUARD.md`。

### 10.1 业务仓库桥接（必须）

每个受管业务仓库**必须**保留一个工作流 `.github/workflows/notify-action-worker.yml`，内容与 `templates/bridge/notify-action-worker.yml` **逐字节一致**，并配置仓库密钥 `AW_DISPATCH_TOKEN`。它只通知、不检出、不执行代码：

| 业务仓库事件 | 桥接发送事件 | 结果 |
|-------------|-------------|------|
| PR 打开/更新/重新打开 | `run-pr-governance` | PR 治理、中央 CI、validate-merge |
| PR 关闭（含合并） | `cancel-pr-work` | 取消该 PR 进行中的治理与中央 CI；未合并时也取消 AI Review |
| push 到 `main` | `run-intake` | 中央 CI、main 写入证明、变更任务、自动部署 |

Dependabot 事件拿不到 Actions 密钥，由 Intake 处理。维护者批准等待批准的 PR 时，GitHub 不提供带密钥事件，由下一次 Intake 运行发现批准；任何受管仓库 `main` push 都会立即启动这次运行。

桥接缺失、Actions 分钟数耗尽或被删除，**既不能产生可信 main SHA，也不能削弱 Release/Deploy 的失败即关闭检查**，只会让 Action Worker 发现变化变慢。可运行在 self-hosted Runner（见 `RUNNER_POLICY.md` §11）。

---

## 11. 任务

任务项目保留在业务仓库，Action Worker 拥有任务入口。

业务仓库在 `.github/task-source.json` 声明：
- `push: true`：默认分支变更由 Intake 自动发现并运行变更项目
- `schedules`：cron 到项目的映射

三种启动方式，结果相同：

| 方式 | 谁启动 | 说明 |
|------|--------|------|
| 变更触发 | Intake `Changed task projects` | `main` push 通过桥接立即唤醒 Intake；若当前 HEAD 无成功 `Task Source` 状态，以第一个父提交为 `before_sha` 分发一次 |
| 定时 | Intake `Scheduled task projects` | 每次 Intake 运行分发过去 12 小时内到期时段，每项目只补最近一个，每时段只分发一次，由 `Task Schedule/<project>` 状态记录 |
| 手动 | 人从 Actions → `手动 · 派发任务` | 只填受管仓库与项目 |

手动启动：`repository` 写 `owner/name`，`project` 是 `projects/` 下含 `task.json` 的目录名。工作流先为该仓库 `main` HEAD 申请中央 CI 并证明 main 写入，任务校验最多等待 20 分钟。

中央仓库**不得**保留业务仓库或项目名称列表。

---

## 12. 常见接入错误（速查）

| 报错 | 处理 |
|------|------|
| `Invalid repository: x. Enter it as owner/name` | 写成 `owner/name` |
| `Repository is not allowed for <能力>` | 修改 `AW_REPOSITORY_POLICY` 增加该仓库能力 |
| `Requested release version must be stable SemVer` | 改成 `1.2.3` 或 `v1.2.3` |
| `source_sha must be a full 40-character lowercase commit SHA` | 填完整 SHA 或留空 |
| `PR title must use type(scope)!: summary format` | 改成 `fix(deploy): retry the health check` |
| `Invalid CHANGELOG entry` / `must use English engineering text` | CHANGELOG 写 `- fix: summary`，摘要用英文 |
| `Attribution check failed` | 作者/提交者/trailer/署名行出现 AI 名称；改成自己的 GitHub 账号，重写提交，强制推送 |

---

## 13. 平台边界

统一执行架构不意味每个 GitHub 套餐具备相同平台强制能力。

在 GitHub Free 套餐下，组织的私有仓库不支持 rulesets 或保护分支，因此这些仓库中的中央门禁属于当前套餐下的流程约束，而不是硬性的平台门禁。公开仓库仍可在平台允许的范围内使用受管的 rulesets。

**平台功能差异不得改变执行合同，也不得成为把重型执行搬回业务仓库的理由。**

---

## 14. 迁移期

部分仓库仍保留旧 CI/Release/Deploy 路径，属于迁移债务。迁移期间旧路径只能缩减；新仓库与新能力直接使用统一执行合同。

---

## 15. 新仓库不应做的事（速查）

接入普通新仓库，**不应**需要：
- 修改 Action Worker 核心脚本
- 添加基于仓库名/项目名的条件判断
- 在 Action Worker 中创建项目专属配置目录
- 自行运行完整 CI/构建/审查/发布/部署
- 自行选择 self-hosted Runner
- 保存中央密钥
- 复制中央策略

如似乎必须做其中之一，先检查是否缺少某项通用能力。