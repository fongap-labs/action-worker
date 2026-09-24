# Repository Governance

Action Worker 保存 Fongap Labs 受管仓库可共享的 Repository 默认设置与合并治理边界。

## 1. Machine authority

统一 Repository Policy 位于：

```text
policies/repository.json
```

当前默认值：

```text
Issues                  ON
Projects                OFF
Wiki                    OFF
Discussions             OFF

Merge commits           OFF
Squash merging          ON
Rebase merging          OFF
Auto-merge              OFF
Update PR branches      ON
Delete head branches    ON

Web commit sign-off     OFF
Squash title            PR title
Squash message          Blank
```

仓库名不进入 Policy；Policy 只描述统一设置。

## 2. Application

`policies/repository.json` 是受管仓库 Repository Settings 的唯一共享权威。

Action Worker 提供两种应用方式：

```text
push to main
  repository policy / apply workflow changed
  → apply to Action Worker itself
  → apply to every repository with the pr capability in AW_REPOSITORY_POLICY

manual workflow_dispatch
  → apply one repository
  → dry-run by default
```

手工输入：

```text
repository = owner/name
is_dry_run = true | false
```

自动同步和手工写操作均使用独立 `AW_ADMIN_TOKEN`，不得与 `AW_CONTROL_TOKEN` 混用。脚本必须幂等应用设置并校验 GitHub 返回结果。

受管仓库不得长期保留与中央 Repository Policy 不一致的设置；如需项目级例外，必须先形成明确的治理理由并修改共享规则或记录例外边界。

## 3. Merge authority

共享治理目标是：

```text
local ci-evidence ───────┐
                         ├→ validate-merge → merge
PR Governance ───────────┘
```

业务仓最终只暴露一个稳定 Required Check：`validate-merge`。它必须同时要求本地 CI Evidence 和 Action Worker 写入的 `PR Governance` 成功。

`validate-merge` 只能由业务仓 GitHub Actions bridge 调用 Action Worker reusable workflow 后创建为 GitHub Check Run；Central CI 只发布 `CI Evidence` / `ci-evidence` commit status，不得再发布同名 `validate-merge` status，避免 Required Check 身份冲突。

## 4. GitHub native enforcement

Repository Policy 与 GitHub 原生保护是两个层次：

```text
Repository Policy
├─ feature switches
├─ merge methods
└─ branch cleanup

GitHub native protection
├─ require pull request
├─ require status checks
├─ protect main
└─ restrict bypass
```

公开受管仓的 Repository Ruleset 由 Action Worker 中央管理，权威文件为 `policies/rulesets.json`。当前统一管理 `Protect Main Branch` 与 `Protect Legacy Branches`；不得在业务仓手工维护另一套规则定义。仓库设置与 Ruleset 均由 `apply-repo-settings.yml` 使用 `AW_ADMIN_TOKEN` 应用。

原生 Ruleset / branch-protection 能力取决于仓库可用的 GitHub 套餐和连接权限。GitHub Free 组织只对公开仓提供 Ruleset 与 Protected Branch；私有仓必须把这一点视为平台限制，不能在文档、审计或自动化中宣称其拥有与公开仓相同的 `main` 强制保护。私有仓仍必须走中央 PR Governance / CI Evidence / validate-merge 流程，但在升级 GitHub 计划前，这属于流程约束而不是 GitHub 平台硬门禁。

中央 `validate-merge` 合同仍应在所有受管仓保持一致；平台原生保护只在能力可用时作为额外强制层。

## 5. Change rule

调整共享默认值时，同步修改：

```text
policies/repository.json
→ governance tests
→ this document
```

项目独有的 Repository 例外必须有明确理由，不得复制成第二套通用 Policy。
