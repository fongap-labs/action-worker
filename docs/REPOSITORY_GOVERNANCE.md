# 仓库治理

Action Worker 统一保存可通过 GitHub Repository API 管理的仓库默认设置，避免每个仓库重复手工配置。

## 1. 权威配置

机器权威位于：

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
Squash message          PR body
```

这组配置保持当前 Fongap Labs 仓库的简洁合并策略：只允许 squash，不自动合并，并在合并后自动删除 head branch。

## 2. 应用方式

Action Worker 提供手动 Workflow：

```text
Apply Repository Settings
```

输入：

```text
repository = owner/name
dry_run    = true | false
```

默认 `dry_run=true`，只显示将应用的配置。确认后再使用 `dry_run=false`。

Workflow 使用独立 Secret：

```text
GH_ADMIN_TOKEN
```

该凭据只用于仓库级 Administration 写操作，不与 `GH_CONTROL_TOKEN` 混用。目标仓库必须显式授予该 Token Administration: Write 权限。

也可以在本地使用已授权的 GitHub CLI：

```bash
GH_TOKEN=<token> bash scripts/apply-repo-settings.sh owner/repository false
```

脚本为幂等 PATCH，并在写入后逐项校验 GitHub 返回值。

## 3. 不由此 Policy 管理的设置

以下设置不进入 `policies/repository.json`：

- Organization Rulesets 与 branch protection；
- GitHub Archive Program；
- Issue / Pull Request 的创建权限细分；
- commit comments；
- Git LFS archive；
- push branch/tag limit；
- linked issue auto-close。

原因是这些设置不属于同一个稳定的 Repository PATCH 接口，或更适合由组织级规则统一管理。不要为了覆盖这些设置把不同权限域混进同一个脚本。

## 4. 与 Ruleset 的关系

仓库默认设置负责“仓库怎么合并”；Organization Ruleset 负责“什么条件下允许合并”。

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

两者互补，不互相复制。

## 5. 修改原则

调整统一默认值时：

1. 修改 `policies/repository.json`；
2. 更新 `tests/test-repo-settings.sh`；
3. 更新本文档；
4. 通过 Action Worker CI；
5. 再对目标仓库执行 Apply Repository Settings。

仓库名不进入 policy。具体应用目标由 Workflow 输入决定。
