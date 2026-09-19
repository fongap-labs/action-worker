# 架构治理

Action Worker 是 Fongap 的 GitHub 自动化控制平面。本文档定义长期边界；实现可以演进，但不得突破这些边界。

## 1. 核心边界

```text
Action Worker
= 通用治理规则
+ PR / Task / Release / Deploy 编排
+ AI Triage / 审查
+ Gate
+ 安全执行边界

业务仓
= 产品代码
+ 测试代码
+ 构建与运行必需文件
+ 最薄事件触发器（不包含治理策略）
```

业务仓不承载 Action Worker 的项目专属策略、Agent 路由、模型选择、Gate 规则或 Release 治理。业务仓允许保留调用中央治理所必需的薄 workflow，但其中只能描述事件、最小权限和 Action Worker 入口。PR 治理由业务仓通过 `repository_dispatch` 发起，实际治理 Workflow 必须运行在 Action Worker。

Action Worker 源码不得出现按仓库名称分支的执行逻辑，也不得创建 `projects/`、`adapters/`、`profiles/` 等项目配置层。

具体仓库白名单属于运行配置，不进入源码。Action Worker 只规定必须执行白名单校验，不保存名单本身。

## 2. 通用执行模型

所有入口最终遵循同一条链路：

```text
Validate
   ↓
Inspect
   ↓
Plan
   ↓
Execute
   ↓
Triage
   ↓
Review
   ↓
Gate
```

- Validate：验证调用来源、事件和输入合同。
- Inspect：从 GitHub 与目标代码获取事实。
- Plan：根据变更、代码和既有证据生成执行计划。
- Execute：在对应信任域执行检查和测试。
- Triage：以低成本结构化判断决定是否需要完整审查以及是否需要升级深度；不得降低确定性安全下限。
- Review：由 AI Agent 审查代码、风险与执行结果。
- Gate：只依据可验证结果决定通过或阻断。

计划可以动态变化，安全边界和 Gate 合同必须稳定。

## 3. 调用方只提交目标

调用方不得决定测试命令、Agent、模型、风险等级或 Gate。

PR Task 最小输入：

```text
schema_version
request_id
repository
pr_number
```

Task Dispatch 最小输入：

```text
schema_version
request_id
project
bootstrap_ref
```

PR 的 base SHA、head SHA、分支、状态和 diff 必须由 Action Worker 从 GitHub 重新获取，不信任调用方声明。

业务仓的 `ACTION_WORKER_TOKEN` 只允许向 Action Worker 发送调度事件；AI Gateway 凭据和跨仓回写凭据不得下沉到业务仓。中央控制域使用 `GH_CONTROL_TOKEN` 读取目标 PR、回写 Review，并向目标 head commit 写入统一 `PR Governance` status。

机器合同位于 `contracts/`。

## 4. 项目白名单

PR 中央执行采用仓库白名单。

白名单从 Repository Variable `PR_REPOSITORY_ALLOWLIST` 读取，值为 repository 名称组成的 JSON 数组。Action Worker 不在源码中保存具体仓库名称。

新增仓库的正常接入动作应尽量只有：

```text
修改 PR_REPOSITORY_ALLOWLIST
→ 配置薄触发器的 ACTION_WORKER_TOKEN
→ 首次 Inspect
→ 正常运行
```

新增或移除普通仓库只应修改 Repository Variable；如果还需要修改核心脚本或增加项目专属 policy，视为架构回退。

## 5. 信任边界

PR 代码属于不可信输入。

控制域：

```text
允许：
- 读取 GitHub 元数据
- 读取 diff
- 生成 Plan
- 执行 AI Triage / Review
- 使用 AI Gateway
- 写 PR Review / Summary
- 写目标 commit 的 PR Governance status

禁止：
- 执行 PR 提供的代码
```

沙箱域：

```text
允许：
- checkout PR head
- build / test / verify
- 执行项目测试代码

禁止：
- 生产 Secret
- AI Gateway Token
- 部署凭据
- 写生产环境
```

具体约束由 `policies/execution.json` 固化。

任何“为了方便”让不可信 PR 代码与中央 Secret 共处的实现都不允许合并。

## 6. 测试与 CI

Action Worker 决定：

```text
什么时候跑
跑到什么强度
哪些结果必须通过
是否需要 AI Review
是否允许合并
```

业务仓保留测试代码，因为测试属于产品规格的一部分；但业务仓不维护 Action Worker 的治理规则。

业务仓 CI Runner 属于 Sandbox：负责执行项目原生测试、构建与验证，并通过统一 `.github/workflows/ci.yml → validate-merge` 暴露最终证据。Action Worker Control 只读取目标 head SHA 对应的 CI Evidence，并据此决定 Gate，不向 Sandbox 下发 AI Gateway 或跨仓控制凭据。

Action Worker 不复制项目测试实现，也不维护仓库名称到测试命令的静态映射。

## 7. 动态理解与历史基线

动态理解用于回答“这次应该验证什么”，但不能替代安全合同。

可积累的历史事实包括：

```text
成功执行过的命令
已验证的能力
已通过的合同
测试结果
变更记录
Release 记录
```

历史基线属于运行状态，不进入 `projects/` 或项目专属源码配置。

错误或未通过 Gate 的结果不得自动成为新基线。

## 8. 双 Agent 原则

高风险或不确定变更采用双 Agent：

```text
Planner
→ 生成验证与审查计划

Critic
→ 检查计划是否漏测、漏验或低估风险
```

Reviewer 在执行结果产生后负责代码与结果审查。

Agent 可以提出计划，不能绕过固定的权限边界和 Gate。

## 9. CHANGELOG、Release 与 Deploy

Deploy 的 Commit 与 CI 共用准入仍由 `validate-source-policy.yml` 负责，`validate-deploy-policy.yml` 在其上增加部署语义。

Release 不再从业务仓直接调用中央 Publish workflow。业务仓先在自身信任域完成 build / package / signing / SBOM / installer validation，并生成包含 `release-manifest.json` 的 Actions artifact。源构建 Run 完成成功后，薄 `workflow_run` dispatcher 只发送 Release Task 身份。

Action Worker 的 `handle-release-dispatch.yml` 使用中央凭据重新验证：

```text
source allowlist
→ source default HEAD
→ successful source run
→ successful ci.yml
→ artifact identity
→ release manifest
→ asset SHA256
→ target allowlist
→ tag/release collision
→ publish
→ re-download verification
→ release or rollback
```

业务仓不得获得目标分发仓写凭据。源读取使用 `GH_CONTROL_TOKEN`；目标发布使用权限收敛到发布目标的 `GH_RELEASE_TOKEN`。

Release Tag 统一为：

```text
<release-key>-v<semver>
```

不再支持裸 `v<semver>` 发布兼容路径。

所有项目继续统一采用：

```text
feat / fix / docs / style / refactor / perf /
test / build / ci / chore / revert
```

`breaking / security / migration` 只作为变更属性。CHANGELOG 与 Release Notes 不定义第二套 Added / Changed / Fixed 分类。

## 10. 仓库结构

允许的长期结构：

```text
.github/workflows/   GitHub 入口
docs/                人类与 Agent 共用治理文档
contracts/           输入/输出机器合同
policies/            通用确定性策略与安全边界
rules/               AI 审查规则
scripts/             通用执行脚本
tests/               Action Worker 自身合同测试
```

禁止新增：

```text
projects/
adapters/
profiles/
```

禁止以仓库名建立目录或规则文件。

## 11. 稳定性原则

```text
main = 当前最新基线
```

普通业务代码变化不应要求修改 Action Worker。

只有以下情况通常允许修改中央治理：

- 全局质量标准变化；
- 全局安全边界变化；
- 输入/输出合同升级；
- GitHub 平台能力变化；
- Action Worker 自身缺陷修复。

目录重命名、普通功能修改、新 API、新模块或普通新仓库接入，不应成为修改中央规则的理由。

## 12. 最短原则

> 白名单决定谁能来；GitHub 决定事实是什么；Action Worker 决定 PR、Source、Release 与 Deploy 怎么治理；沙箱负责运行不可信代码；Gate 只相信可验证结果。
