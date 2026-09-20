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

Action Worker 提供手动 `Apply Repository Settings` workflow。

输入：

```text
repository = owner/name
is_dry_run = true | false
```

默认 dry-run。写操作使用独立 `GH_ADMIN_TOKEN`，不得与 `GH_CONTROL_TOKEN` 混用。脚本必须幂等应用设置并校验 GitHub 返回结果。

## 3. Merge authority

共享治理目标是：

```text
local ci-evidence ───────┐
                         ├→ validate-merge → merge
PR Governance ───────────┘
```

业务仓最终只暴露一个稳定 Required Check：`validate-merge`。它必须同时要求本地 CI Evidence 和 Action Worker 写入的 `PR Governance` 成功。

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

原生 Ruleset / branch-protection 能力取决于仓库可用的 GitHub 套餐和连接权限。当前私有仓如果 GitHub API 返回套餐限制，不得在文档中假设其拥有与公共仓完全相同的原生 Ruleset。

中央 `validate-merge` 合同仍应在所有受管仓保持一致；平台原生保护只在能力可用时作为额外强制层。

## 5. Change rule

调整共享默认值时，同步修改：

```text
policies/repository.json
→ governance tests
→ this document
```

项目独有的 Repository 例外必须有明确理由，不得复制成第二套通用 Policy。
