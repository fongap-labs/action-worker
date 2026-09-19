# Documentation

Action Worker 的共用治理文档统一维护在本目录。

人类和 Agent 都从这里进入；Agent 的强制读取顺序见仓库根目录 [CLAUDE.md](../CLAUDE.md)。

## 权威文档

| 文档 | 作用 |
|---|---|
| [ARCHITECTURE_GOVERNANCE.md](ARCHITECTURE_GOVERNANCE.md) | 长期架构边界与不可突破原则 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前实现与运行模型 |
| [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) | 文件、Workflow、参数与变量命名规范 |
| [CHANGELOG_CONVENTIONS.md](CHANGELOG_CONVENTIONS.md) | PR、CHANGELOG 与 Release 的统一变更分类 |
| [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) | 通用开发、验证、PR 与合并流程 |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | 新业务仓接入 Action Worker 的标准方法 |
| [REPOSITORY_GOVERNANCE.md](REPOSITORY_GOVERNANCE.md) | 仓库默认设置与 Organization Ruleset 的职责边界 |

## 机器规则

文档解释“为什么”和“怎么做”，机器权威仍在：

```text
contracts/   输入输出合同
policies/    确定性治理策略
rules/       AI Review 规则
tests/       合同与治理回归测试
```

文档不得覆盖或绕过机器合同。

## 最短入口

```text
开发 Action Worker
→ CLAUDE.md
→ docs/DEVELOPMENT_GUIDE.md
→ 相关 contracts / policies / rules

接入业务仓
→ CLAUDE.md
→ docs/INTEGRATION_GUIDE.md
→ docs/ARCHITECTURE_GOVERNANCE.md

修改治理规则
→ docs/ARCHITECTURE_GOVERNANCE.md
→ 相关 contracts / policies
→ 合同测试

统一仓库默认设置
→ docs/REPOSITORY_GOVERNANCE.md
→ policies/repository.json
→ Apply Repository Settings
```
