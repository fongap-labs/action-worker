# Fongap Labs Shared Governance

本文件定义 Fongap Labs 受管仓库的共用工程治理。只要一条规则适用于两个及以上仓库，就优先在 Action Worker 中维护；业务仓只保存项目本身独有的产品、架构、运行和边界规则。

## 1. 权威边界

```text
Action Worker
= shared governance
+ machine contracts / policies / rules
+ unified execution plane
+ PR / CI / Review / Build / Release / Deploy / Task governance
+ runner resolution and execution provenance

Business repository
= product source
+ product tests
+ project architecture
+ project-specific scripts and boundaries
+ execution manifest
+ thin integration workflows
```

业务仓不得复制 Action Worker 已经定义的通用命名、变更分类、PR Gate、Execution Governance、Release Governance、Repository Policy 或 Agent 工程规则。

公开仓库与私有仓库使用同一执行架构。除最薄 dispatch 和 GitHub 平台必须由目标仓创建的桥接检查外，CI、test、build、AI Review、release、deploy 和 scheduled task 等重执行统一进入 Action Worker。仓库可见性只能影响访问与平台保护能力，不得形成第二套执行路径。

统一执行边界以 [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md) 为准；Runner 抽象与 self-hosted 边界以 [RUNNER_POLICY.md](RUNNER_POLICY.md) 为准。

## 2. Shared rules

以下规则由 Action Worker 统一维护：

- repository governance and merge defaults;
- naming conventions;
- changelog and PR change classification;
- English-only engineering diff, PR titles, CHANGELOG entries and release summaries;
- common development and validation rules;
- PR governance and merge-gate contract;
- unified execution contract for public and private repositories;
- central CI / build / review / release / deploy / task execution;
- runner profiles, runner resolution and self-hosted boundaries;
- release and deploy governance;
- cross-repository trust and secret boundaries;
- common Agent entry and precedence rules;
- cross-repository language and runtime convergence rules.

语言治理遵循同一长期原则：小内核、大框架优先于任何单一语言目标。语言选择服从模块边界；在性能、安全、功能、兼容性和维护性不下降时优先减少无必要的语言与运行时，但禁止为了“统一技术栈”而重写已经稳定且边界清晰的实现。跨语言重复 Authority、重复状态和重复协议必须优先消除。

## 3. Project-local rules

业务仓只保留无法脱离该项目成立的规则，例如：

- product positioning and product boundary;
- runtime / protocol / public API architecture;
- repository-specific dependency rules;
- product-specific security invariants;
- project release compatibility;
- capability or extension boundaries;
- project-specific build, package and deploy implementation.

判断标准：

> 如果删除项目名后这条规则仍然适用于其他仓库，它通常不应继续留在业务仓。

## 4. Authority order

发生冲突时按以下顺序处理：

```text
machine contracts / policies / rules
        ↓
Action Worker shared governance
        ↓
project architecture / project boundary
        ↓
project implementation documentation
        ↓
README / examples
```

项目规则可以收紧共用规则，但不得绕过共用安全边界、PR Gate 或跨仓凭据边界。

AI Review 不是共用门禁。它只负责审核、建议与问题发现；是否启用、是否成功、发现多少问题，都不能替代或改变确定性的 CI / PR / Security Gate。

Security Gate 属于共用硬边界，必须由 Action Worker 的确定性检查执行，并覆盖公开仓与私有仓。

`validate-merge` 是唯一 Merge Authority。AI Review 必须在确定性 Gate 结论之后运行，只产生 advisory finding。

Main Write Guard 是所有受管仓共享的 main provenance 硬边界。任何无法证明来自合法 PR Merge 的 `main` SHA 都视为 untrusted，不得 Release、Deploy、Publication 或进入 privileged execution。详细规则见 [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md)。

## 5. Agent entry

每个受管业务仓保留两个极薄入口：

```text
AGENTS.md
  ↓
CLAUDE.md
  ↓
Action Worker shared governance
  ↓
project-specific authoritative documents
```

`AGENTS.md` 只负责跳转，不复制规则。业务仓 `CLAUDE.md` 只列出共享规则入口、项目级权威文档以及项目独有的少量禁止项。

## 6. Machine enforcement

文档解释规则，但真正的治理必须由机器合同执行：

```text
contracts/   input/output contracts
policies/    deterministic policy
rules/       AI review policy
actions/     merge enforcement
workflows/   orchestration
tests/       governance regression tests
```

任何重要规则如果只存在于 Markdown、没有对应机器约束，应被视为尚未完成治理闭环。

## 7. Platform capability

治理目标与 GitHub 套餐能力分开描述。

Action Worker Gate 对受管仓统一成立；GitHub 原生 Ruleset、branch protection 或 Administration API 只在当前仓库可用的套餐和权限范围内启用。GitHub Free 组织的私有仓不具备 Ruleset / Protected Branch 强制保护，因此中央 Gate 在这些仓库中是流程约束而非 GitHub 平台硬门禁。平台能力不足不能成为绕过中央 Gate 的理由，也不得在文档中假设私有仓已经获得与公开仓相同的强制保护。
