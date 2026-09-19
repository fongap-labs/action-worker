# 仓库治理

Action Worker 统一保存可通过 GitHub Repository API 管理的仓库默认设置，避免各业务仓重复手工维护。

## 1. 机器权威

统一策略位于：

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

## 2. 应用方式

Action Worker 提供手动 Workflow：

```text
Apply Repository Settings
```

输入：

```text
repository = owner/name
is_dry_run = true | false
```

默认 `is_dry_run=true`，只显示计划应用的设置。确认后再使用 `false`。

Workflow 使用独立 Secret：

```text
GH_ADMIN_TOKEN
```

该凭据只用于 Repository Administration 写操作，不与 `GH_CONTROL_TOKEN` 混用。目标仓必须显式授予 Administration: Write。

也可以使用已授权 GitHub CLI：

```bash
GH_TOKEN=<token> bash scripts/apply-repo-settings.sh owner/repository false
```

脚本执行幂等 PATCH，并对 GitHub 返回结果逐项校验。

## 3. 边界

该 Policy 管理仓库级 feature switch、merge method 和 branch cleanup，不负责 Organization Ruleset、branch protection 或其他独立权限域。

推荐边界：

```text
Repository Policy
├─ feature switches
├─ merge methods
└─ branch cleanup

Organization Ruleset
├─ protect main
├─ require pull request
├─ require status checks
└─ restrict bypass
```

调整统一默认值时，同步修改 Policy、合同测试和本文档，再通过 Action Worker CI。
