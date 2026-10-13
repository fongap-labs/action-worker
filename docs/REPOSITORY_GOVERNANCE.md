# 仓库治理

Action Worker 维护受管 Fongap Labs 仓库可共享的仓库默认设置与合并治理边界。

## 1. 机器权威

统一的 Repository Policy 位于：

```text
policies/repository.json
```

当前默认值：

```text
Issues                  开启
Projects                关闭
Wiki                    关闭
Discussions             关闭

Merge commits           关闭
Squash merging          开启
Rebase merging          关闭
Auto-merge              关闭
Update PR branches      开启
Delete head branches    开启

Web commit sign-off     关闭
Squash title            PR title
Squash message          Blank
```

Repository Policy 不包含仓库名称，只描述共享设置。

## 2. 应用方式

`policies/repository.json` 是受管仓库 Repository Settings 的唯一共享权威。

Action Worker 通过两种方式应用它：

```text
push 到 main
  repository policy / apply workflow 变更
  → 应用到 Action Worker 自身
  → 应用到 AW_REPOSITORY_POLICY 中每个具有 pr 能力的仓库

手动 workflow_dispatch
  → 应用到一个仓库
  → 默认为 dry-run（演练）
```

手动输入：

```text
repository = owner/name
is_dry_run = true | false
```

自动同步与手动写入都使用独立的 `AW_ADMIN_TOKEN`，绝不使用 `AW_CONTROL_TOKEN`。脚本以幂等方式应用设置，并核对 GitHub 返回的结果。

受管仓库不得长期保留与中央 Repository Policy 不一致的设置。项目级的例外必须先有明确的治理理由，然后要么修改共享规则，要么记录一个例外边界。

## 3. 合并权限

共用治理的目标是：

```text
Security Gate ───────────┐
Central CI Evidence ─────┤
PR 确定性策略 ───────────┼→ validate-merge → 合并
                         │
                         └→ 门禁之后的 AI Review（仅供参考）
```

`validate-merge` 是唯一的合并权限。Action Worker 在当前 PR head 上直接发布它，前提是确定性的 Security、CI Evidence 与 PR Policy 检查全部通过；AI Review 不是它的输入，也不得改变其结果。

业务仓库不再创建 `validate-merge` 检查。公开仓库的 ruleset 直接要求中央 `validate-merge` 状态；Free 套餐的私有仓库没有等效的平台硬门禁，但 Main Write Guard 仍要求同一个中央状态，因此两类仓库使用相同的治理事实。

业务仓库中 PR 关闭时的本地 `cancel-pr-work`，只是迁移期的实时加速手段；中央 Intake / 对账必须保证，即使业务仓库的 Actions 不可用，中央控制平面仍能识别并结束过期的工作。

## 4. GitHub 原生强制

仓库策略与 GitHub 原生保护是两层：

```text
Repository Policy
├─ 功能开关
├─ 合并方式
└─ 分支清理

GitHub 原生保护
├─ 要求 pull request
├─ 要求状态检查
├─ 保护 main
└─ 限制绕过
```

受管公开仓库的 repository rulesets 由 Action Worker 集中管理，权威文件为 `policies/rulesets.json`。它目前管理 `Protect Main Branch` 与 `Protect Legacy Branches`；业务仓库不得手动维护第二份规则定义。Repository Settings 与 rulesets 都由 `apply-repository-settings.yml` 使用 `AW_ADMIN_TOKEN` 应用。

原生 ruleset / 分支保护取决于仓库所在的 GitHub 套餐与连接权限。GitHub Free 组织只为公开仓库提供 rulesets 与保护分支；对于私有仓库，这是平台限制。文档、审计与自动化绝不能声称私有仓库具备与公开仓库相同的强制 `main` 保护。私有仓库仍走中央 PR Governance / CI Evidence / validate-merge 流程；平台目前可能在写入之前缺少强制力，但 Main Write Guard 会在写入之后，将任何缺少中央合并权限的 main SHA 隔离。

中央 `validate-merge` 合同在每个受管仓库中保持不变；平台原生保护只是在可用时额外提供的一层强制。

## 5. Main Write Guard

受管仓库中 `main` 的每一次更新，都进入同一个 Main Write Guard。它的职责不是重复 PR 门禁，而是验证当前 `main` SHA 的来源是否合法。

```text
validate-merge
→ PR 已合并
→ main 已更新
→ Main Write Guard
→ 可信的 main SHA
```

Main Write Guard 依据 GitHub 上的当前事实再次证明：目标 SHA 来自一个合并进 `main` 的 PR，且该 PR/head 通过了所需的确定性门禁。它从不信任 commit message、actor、自报的 PR 编号，或调用方提供的门禁结论。

如果无法证明合法来源：

```text
Main Write Guard = failure
→ 源 SHA = untrusted（不可信）
→ 拒绝 Release
→ 拒绝 Deploy
→ 拒绝 Publication
→ 拒绝特权执行
```

在 GitHub 原生保护可用的情况下，公开仓库还依赖 ruleset 在写入之前拒绝直接 push；在 Free 套餐的私有仓库中，即使平台允许直接 push，Main Write Guard 也会隔离该 SHA，使其无法进入正式输出链。

详细规则见 [MAIN_WRITE_GUARD.md](MAIN_WRITE_GUARD.md)。

## 6. 变更规则

当共享默认值发生变化时，应同时修改：

```text
policies/repository.json
→ 治理测试
→ 本文件
```

仅针对某个项目的仓库例外，必须有明确的理由，并且不得被复制到第二份通用策略中。
