# Agent Guide

本文件是 Action Worker 的 Agent 统一入口。

适用于 Claude、Codex、OpenCode 以及其他参与开发、审查、治理和发布的 Agent。Agent 不应依赖各自工具的隐含默认规则；本仓库的工程边界以本文件和其引用的权威文件为准。

## 1. 必读顺序

开始任何任务前，按以下顺序读取：

1. `CLAUDE.md`
2. `docs/README.md`
3. `docs/ARCHITECTURE_GOVERNANCE.md`
4. `docs/NAMING_CONVENTIONS.md`
5. 与任务直接相关的 `contracts/`、`policies/`、`rules/`
6. 开发任务再读 `docs/DEVELOPMENT_GUIDE.md`
7. 新仓库接入或跨仓改造再读 `docs/INTEGRATION_GUIDE.md`

不要跳过机器合同直接依据 README 或历史经验修改治理逻辑。

## 2. 权威顺序

出现冲突时按以下优先级处理：

```text
contracts / policies / rules
        ↓
docs/ARCHITECTURE_GOVERNANCE.md
        ↓
docs/ARCHITECTURE.md
        ↓
docs/NAMING_CONVENTIONS.md
        ↓
docs/DEVELOPMENT_GUIDE.md / INTEGRATION_GUIDE.md
        ↓
README.md
```

机器合同和确定性 policy 不得被 Agent 自行绕过。

## 3. Action Worker 的职责

Action Worker 是 GitHub 自动化控制平面，负责：

- Task Dispatch；
- PR Governance；
- AI Triage；
- AI Review；
- CI Evidence；
- Gate；
- Source Policy；
- Release Policy；
- GitHub Release Publish；
- Deploy Policy；
- 跨仓治理状态回写。

业务仓负责：

- 产品代码；
- 产品测试代码；
- 项目原生 build / package / deploy 实现；
- 最薄的 Action Worker 调用入口。

能通用的治理能力必须优先进入 Action Worker；项目差异应留在业务仓，不通过仓库名分支、项目目录或中央静态映射表达。

## 4. 禁止架构回退

禁止在 Action Worker 新增：

```text
projects/
adapters/
profiles/
```

禁止：

- `if repository == ...` 一类仓库名分支；
- 把业务仓专属构建命令复制进中央治理；
- 在业务仓复制 PR、Gate、Release 等通用治理策略；
- 让 PR 不可信代码获得 AI Gateway、跨仓控制或部署 Secret；
- 通过修改模型、阈值或重跑来洗掉不利审查结论。

## 5. 信任边界

```text
Control
├─ GitHub metadata / diff
├─ Plan
├─ AI Triage
├─ AI Review
├─ CI Evidence
├─ Gate
└─ central secrets allowed

Sandbox
├─ checkout PR head
├─ build / test / verify
└─ central secrets forbidden
```

Agent 可以动态生成 Plan，但不能动态改变权限边界和 Gate。

## 6. PR 与 CI

业务仓 PR 通过 `dispatch-pr-governance.yml` 发送最小任务。

Action Worker 必须重新从 GitHub 获取事实，不信任调用方声明的 SHA、风险、Agent、模型或 Gate 结论。

需要 CI 的变更统一使用：

```text
.github/workflows/ci.yml
        ↓
ci-evidence
        ↓
Action Worker PR Governance
        ↓
validate-merge
```

项目测试实现仍在业务仓；Action Worker 读取 `ci-evidence`，最终 `validate-merge` 使用中央 `validate-merge-policy` 同时要求本地证据和 `PR Governance` 成功。

## 7. AI Review

模型能力顺序：

```text
Code-Air < Code-Pro < Code-Max < Code-Ultra
```

模型职责：

```text
Code-Air   = AI Triage，只做短、结构化的路由判断
Code-Pro   = 普通完整 Review
Code-Ultra = security / architecture / deep Review
```

确定性 Plan 是安全下限。AI Triage 失败时保留原 Plan；Triage 只能在严格低风险条件下跳过普通 `code` Review，或把审查升级到更强 Agent / 模型，不得降低确定性高风险路由。

Action Worker 不因模型连通或 Provider 抖动主动切换模型，也不做整轮 Review 重试。请求级 retry 由 OpenCodeReview 负责，模型与 Provider fallback 由 AI Gateway 负责。合法审查结果产生后立即进入 Gate，不得因为 finding 或 Gate 结果不理想而换模型重审。

安全和架构高风险任务直接使用 `Code-Ultra`，不经过 Air 降级判断。

## 8. Source / Release / Deploy

Deploy 继续复用：

```text
validate-source-policy.yml
validate-deploy-policy.yml
```

Release 使用独立的中央 Dispatch 链路：

```text
source build artifact
→ workflow_run completed
→ repository_dispatch: run-release
→ handle-release-dispatch.yml
→ validate-release-request.ts
→ publish-release.ts
```

Release Dispatch 与 Release Manifest 分别由：

```text
contracts/release-dispatch.json
contracts/release-manifest.json
```

定义。

业务仓只保留产品专属 build、签名、SBOM、安装包验证，以及最薄的 Release Dispatch 入口。业务仓不得持有目标分发仓写凭据。

Action Worker 使用：

```text
GH_CONTROL_TOKEN
GH_RELEASE_TOKEN
RELEASE_SOURCE_ALLOWLIST
RELEASE_TARGET_ALLOWLIST
```

重新验证源仓默认 HEAD、成功的 `ci.yml`、已完成的源构建 Run、artifact manifest 与 SHA256，然后发布到允许的目标仓。

Release Tag 固定为：

```text
<release-key>-v<semver>
```

不支持裸 `v<semver>` 兼容路径。

## 9. 修改原则

开发时遵循：

- 先确认现有合同，再改实现；
- 优先复用现有脚本、policy 和 workflow；
- 能参数化就不复制；
- 能按语义判断就不按仓库名判断；
- 修改治理逻辑必须补合同测试；
- 修改 Workflow 必须通过 actionlint、本仓 CI，以及在存在 Shell 边界时通过 ShellCheck；
- 不把一次性兼容逻辑长期留在主线；
- 不增加无必要的抽象层。

## 10. 命名

统一遵守 `docs/NAMING_CONVENTIONS.md`。

核心记忆：

```text
一个概念，一个标准词
一个名称，最多三段
动作：Verb + Object + Qualifier
对象：Object + Role + Qualifier
```

## 11. 提交与 PR

变更分类、PR 标题和 CHANGELOG 统一遵守 `docs/CHANGELOG_CONVENTIONS.md`。

Agent 完成修改后必须根据最终 diff 判断真实 Type 和属性，不得根据最初任务描述猜测。

## 12. 结束条件

任务只有在以下条件满足后才算完成：

- 代码或文档已实际写入目标分支；
- 相关合同测试已更新；
- CI 已验证；
- 需要合并的 PR 已确认状态；
- 没有留下与新架构冲突的旧入口或重复规则；
- README / docs 与实现一致。
