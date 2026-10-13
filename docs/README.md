# 文档索引

Action Worker 保存三类文档：

1. Fongap Labs 受管仓库的共用治理；
2. Action Worker 控制平面的架构与实现；
3. 可复用的工程执行 Agent Skills。

受管仓库只保留项目专属规则，不复制本仓库的共用治理。

## 共用治理

| 文档 | 用途 |
|---|---|
| [SHARED_GOVERNANCE.md](SHARED_GOVERNANCE.md) | 共用治理边界与 Fongap Labs 各仓库之间的权威关系 |
| [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md) | 公开仓库与私有仓库统一的执行边界 |
| [TEST_PACKS.md](TEST_PACKS.md) | 中央持有的测试包、共用测试套件与清单棘轮（只增不减的测试基线） |
| [RUNNER_POLICY.md](RUNNER_POLICY.md) | Runner Profile、后端解析、信任域与 self-hosted 边界 |
| [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md) | main 分支的来源证明、直接写入隔离与下游信任要求 |
| [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) | 共用命名规则，以及 Action Worker 自身的附加约束 |
| [CHANGELOG_CONVENTIONS.md](CHANGELOG_CONVENTIONS.md) | PR、CHANGELOG 与 Release 的统一变更分类 |
| [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) | 通用开发、验证、PR 与合并规则 |
| [REPOSITORY_GOVERNANCE.md](REPOSITORY_GOVERNANCE.md) | 仓库设置、合并策略与 GitHub 平台能力边界 |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | 受管仓库接入中央治理的标准规范 |

## Agent Skills

可复用 Agent 执行行为的权威来源位于 [`skills/`](../skills/README.md)。Skill 只定义执行流程，不得覆盖机器合同、策略或规则。

## Action Worker 专属文档

| 文档 | 用途 |
|---|---|
| [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md) | 控制平面的长期架构边界 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前实现与运行模型 |

## 决策记录

| 文档 | 用途 |
|---|---|
| [proposals/](proposals/) | 决策记录。每个文件写明状态，以及尚需 owner 完成的步骤 |

## 机器权威

文档解释"为什么"与"怎么做"；机器权威仍然位于：

```text
contracts/   输入输出合同
policies/    确定性治理策略
rules/       AI 审查规则
tests/       合同与治理回归测试
```

Agent Skills 是可复用的执行流程，不是确定性策略的权威。文档与 Skill 都不得覆盖或绕过机器合同。

## 最短入口

```text
开发 Action Worker
→ CLAUDE.md
→ skills/agent-execution/SKILL.md
→ 任务相关的 skill
→ docs/SHARED_GOVERNANCE.md
→ docs/ARCHITECTURE_GOVERNANCE.md
→ docs/EXECUTION_CONTRACT.md
→ docs/RUNNER_POLICY.md
→ docs/MAIN_WRITE_GUARD.md
→ 相关 contracts / policies / rules

在受管仓库中工作
→ 仓库自身的 CLAUDE.md
→ docs/SHARED_GOVERNANCE.md
→ 项目专属的架构与边界文档

修改共用治理
→ docs/SHARED_GOVERNANCE.md
→ 相关 contracts / policies / rules
→ 治理回归测试
```
