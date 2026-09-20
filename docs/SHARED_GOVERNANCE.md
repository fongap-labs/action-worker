# Fongap Labs Shared Governance

本文件定义 Fongap Labs 受管仓库的共用工程治理。只要一条规则适用于两个及以上仓库，就优先在 Action Worker 中维护；业务仓只保存项目本身独有的产品、架构、运行和边界规则。

## 1. 权威边界

```text
Action Worker
= shared governance
+ machine contracts / policies / rules
+ PR / Release / Deploy governance

Business repository
= product source
+ product tests
+ project architecture
+ project-specific contracts and boundaries
+ thin integration workflows
```

业务仓不得复制 Action Worker 已经定义的通用命名、变更分类、PR Gate、Release Governance、Repository Policy 或 Agent 工程规则。

## 2. Shared rules

以下规则由 Action Worker 统一维护：

- repository governance and merge defaults;
- naming conventions;
- changelog and PR change classification;
- common development and validation rules;
- PR governance and merge-gate contract;
- release and deploy governance;
- cross-repository trust and secret boundaries;
- common Agent entry and precedence rules.

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

Action Worker Gate 对受管仓统一成立；GitHub 原生 Ruleset、branch protection 或 Administration API 只在当前仓库可用的套餐和权限范围内启用。平台能力不足不能成为绕过中央 Gate 的理由，也不应在文档中假设所有仓库拥有完全相同的 GitHub 原生保护能力。
