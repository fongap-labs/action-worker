# 仓库治理

Action Worker 维护受管 Fongap Labs 仓库可共享的仓库默认设置与合并治理边界。

---

## 1. 机器权威

统一的 Repository Policy 位于：

```
policies/repository.json
```

当前默认值：

```
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
Squash title            PR 标题（PR_TITLE）
Squash message          空（BLANK）
```

Repository Policy 不包含仓库名称，只描述共享设置。

---

## 2. 应用方式

`policies/repository.json` 是受管仓库 Repository Settings 的唯一共享权威。

Action Worker 自动应用它，无需手动运行：

```
push 到 main（repository policy / ruleset policy / apply 脚本或工作流变更）
每天一次定时运行（纠正有人在仓库设置页面手动改动造成的漂移）
  → 应用到 Action Worker 自身
  → 应用到 AW_REPOSITORY_POLICY 中每个具有 pr 能力的仓库
```

两种运行都使用独立的 `AW_ADMIN_TOKEN`，绝不使用 `AW_CONTROL_TOKEN`。脚本以幂等方式应用设置，并核对 GitHub 返回的结果；ruleset 已是最新时只打印 `already current`，不做写入。

需要在合并前预览一项策略变更时，在本地运行：
```bash
node scripts/apply-repository-settings.ts <owner/name> true
```
它只打印将要应用的设置与 rulesets，不调用 GitHub。

受管仓库不得长期保留与中央 Repository Policy 不一致的设置。项目级的例外必须先有明确的治理理由，然后要么修改共享规则，要么记录一个例外边界。

---

## 3. 合并权限

共用治理的目标门禁流程：

```
Security Gate ───────────┐
Central CI Evidence ─────┤
PR 确定性策略 ───────────┼→ validate-merge → 合并
                          │
                          └→ 门禁之后的 AI Review（仅供参考）
```

`validate-merge` 是**唯一的合并权限**。Action Worker 在当前 PR head 上直接发布它，前提是确定性的 Security、CI Evidence 与 PR Policy 检查全部通过；AI Review 不是它的输入，也不得改变其结果。

业务仓库不再创建 `validate-merge` 检查。公开仓库的 ruleset 直接要求中央 `validate-merge` 状态；Free 套餐的私有仓库没有等效的平台硬门禁，但 Main Write Guard 仍要求同一个中央状态，因此两类仓库使用相同的治理事实。

业务仓库中 PR 关闭时的本地 `cancel-pr-work`，只是迁移期的实时加速手段；中央 Intake / 对账必须保证，即使业务仓库的 Actions 不可用，中央控制平面仍能识别并结束过期的工作。

---

## 4. GitHub 原生强制

仓库策略与 GitHub 原生保护是两层：

```
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

受管公开仓库的 repository rulesets 由 Action Worker 集中管理，权威文件为 `policies/rulesets.json`。它目前管理 `Protect Main Branch` 与 `Protect Legacy Branches`；业务仓库**不得手动维护第二份规则定义**。Repository Settings 与 rulesets 都由 `apply-repository-settings.yml` 使用 `AW_ADMIN_TOKEN` 应用。

原生 ruleset / 分支保护取决于仓库所在的 GitHub 套餐与连接权限。**GitHub Free 组织只为公开仓库提供 rulesets 与保护分支**；对于私有仓库，这是平台限制。文档、审计与自动化绝不能声称私有仓库具备与公开仓库相同的强制 `main` 保护。私有仓库仍走中央 PR Governance / CI Evidence / validate-merge 流程；平台目前可能在写入之前缺少强制力，但 Main Write Guard 会在写入之后，将任何缺少中央合并权限的 main SHA 隔离。

中央 `validate-merge` 合同在每个受管仓库中保持不变；平台原生保护只是在可用时额外提供的一层强制。

---

## 5. Main Write Guard 引用

Main Write Guard 的完整规则、触发时机、证明逻辑、失败后果、业务仓库桥接与故障排查见 `07-main-write-guard.md`。

本文件仅记录仓库治理层面的接口：
- 公开仓库：ruleset 在写入前拒绝直接 push；Main Write Guard 在写入后二次隔离
- Free 套餐私有仓库：平台允许直接 push，Main Write Guard 隔离该 SHA，使其无法进入正式输出链（Release/Deploy/Publication/特权执行）

---

## 6. 变更规则

当共享默认值发生变化时，应同时修改：

```
policies/repository.json
→ 治理测试
→ 本文件
```

仅针对某个项目的仓库例外，必须有明确的理由，并且不得被复制到第二份通用策略中。

---

## 7. 关键文档速查

| 需求 | 读哪份 |
|------|--------|
| 完整 Main Write Guard 规则 | `07-main-write-guard.md` |
| 业务仓库桥接模板与事件表 | `05-integration-guide.md` §3 |
| Release/Deploy 运维操作 | `06-release-deploy-guide.md` |
| 共用治理宪法与语言规则 | `01-shared-governance.md` |