# 文档

[English](README.md) · **简体中文**

Action Worker 同时保存三类内容：

1. Fongap Labs 受管仓库共用治理；
2. Action Worker 自身控制平面架构与实现；
3. 工程执行使用的通用 Agent Skills。

业务仓只保存项目级规则，不复制这里的共用规则。

## Shared governance

| Document | Purpose |
|---|---|
| [SHARED_GOVERNANCE.md](SHARED_GOVERNANCE.md) | Fongap Labs 共用治理边界与权威关系 |
| [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) | 全仓通用命名规则，以及 Action Worker 自身附加约束 |
| [CHANGELOG_CONVENTIONS.md](CHANGELOG_CONVENTIONS.md) | PR、CHANGELOG 与 Release 的统一变更分类 |
| [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) | 通用开发、验证、PR 与合并规则 |
| [REPOSITORY_GOVERNANCE.md](REPOSITORY_GOVERNANCE.md) | 仓库设置、合并策略与 GitHub 平台能力边界 |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | 业务仓接入中央治理的标准合同 |

## Agent Skills

可复用 Agent 执行行为的权威入口位于 [`skills/`](../skills/README.md)。Skill 定义执行流程，但不得覆盖机器合同、Policy 或 Rule。

## Action Worker specific

| Document | Purpose |
|---|---|
| [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md) | Action Worker 控制平面的长期架构边界 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前实现与运行模型 |

## Machine authority

文档解释“为什么”和“怎么做”，机器权威仍在：

```text
contracts/   输入输出合同
policies/    确定性治理策略
rules/       AI Review 规则
tests/       合同与治理回归测试
```

Agent Skills 是可复用执行流程，不属于确定性策略权威；文档与 Skill 都不得覆盖或绕过机器合同。

## Shortest entry

```text
Develop Action Worker
→ CLAUDE.md
→ skills/agent-execution/SKILL.md
→ task-related skill
→ docs/SHARED_GOVERNANCE.md
→ docs/ARCHITECTURE_GOVERNANCE.md
→ related contracts / policies / rules

Work in a managed repository
→ repository CLAUDE.md
→ docs/SHARED_GOVERNANCE.md
→ project-specific architecture / boundary docs

Change shared governance
→ docs/SHARED_GOVERNANCE.md
→ related contracts / policies / rules
→ governance regression tests
```
