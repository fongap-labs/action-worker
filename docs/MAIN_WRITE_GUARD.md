# Main Write Guard

本文档定义受管仓库 `main` 分支的写入来源边界。

## 1. 目标

所有受管仓库，不分 public / private，都遵守：

```text
Only a PR that passed deterministic gates
may produce a trusted main SHA.
```

长期目标不是“检测直接 push”，而是让未经合法 PR Merge 产生的 `main` SHA 无法进入任何正式执行链。

## 2. 两道门

```text
Before main
  validate-merge
  = merge eligibility

After main update
  Main Write Guard
  = main provenance
```

`validate-merge` 决定 PR 是否具备合并资格。

`Main Write Guard` 验证 `main` 当前 SHA 是否确实由一个已通过治理、已合并到 `main` 的 PR 产生。

两者职责不可合并，也不能互相替代。

## 3. 合法 main 写入

Main Write Guard 必须从 GitHub 当前事实重新验证，而不是相信提交消息、调用方参数或本地状态。

长期最小条件：

```text
repository is managed
head SHA is immutable
head SHA is associated with a merged PR
PR base is main
PR merge result matches the main update
required deterministic gate was successful for that PR/head
```

实现应适配仓库当前允许的 Merge Method。对于 Fongap Labs 当前统一的 Squash Merge，必须验证 GitHub 返回的 merged PR 与目标 `main` SHA 的真实关系。

不得用以下信息单独证明合法性：

- commit message；
- actor 名称；
- branch 名称；
- workflow 输入；
- 自报的 PR number；
- 自报的 `validate-merge` 结果。

## 4. 非法 main 写入

如果 Main Write Guard 无法证明当前 `main` SHA 来自合法 PR Merge，该 SHA 必须标记为 untrusted。

```text
direct push / unknown write
        ↓
Main Write Guard = failure
        ↓
main SHA = untrusted
        ↓
Release denied
Deploy denied
Publication denied
Privileged task denied
```

在 GitHub 平台无法预先阻止直接 push 的仓库中，Workflow 仍必须 fail closed：未经证明的 SHA 不能获得任何正式产出能力。

是否自动回滚非法写入属于执行策略，不能替代上述信任判定。即使自动回滚失败，untrusted SHA 仍不得 Release / Deploy。

## 5. Public 与 Private

### Platform enforcement available

当 GitHub Ruleset / Protected Branch 可用时：

```text
require pull request
+ require validate-merge
+ no bypass actor
+ restrict direct main update
```

GitHub 在写入前拒绝非法路径，Main Write Guard 继续作为 provenance 二次验证。

### Platform enforcement unavailable

当当前 GitHub 套餐无法对 private repository 提供等价强制保护时：

```text
direct main write may physically occur
→ Main Write Guard must fail
→ resulting SHA is quarantined
→ every privileged downstream path must reject it
```

平台能力差异不能产生第二套治理模型。

## 6. Workflow boundary

Main Write Guard 的安全性不得依赖业务仓 Actions 是否可运行。

权威基线由公开 `action-worker` 的中央 Main Write Audit 周期性重新读取所有受管仓当前 `main`，并独立验证 provenance。这样即使业务仓没有 Actions 额度、dispatcher 被删除或直接 push 同时修改 workflow，也不能为非法 SHA 产生信任。

业务仓可以保留极薄 `main` push bridge 作为实时加速，但它不是安全前提，也不得自行产生 trusted 结论。

可选实时事件的长期最小字段：

```text
repository
before_sha
head_sha
event
request_id
```

调用方不得提交：

- “这是合法 Merge”的布尔结论；
- PR Gate 结果；
- release/deploy 授权；
- Secret；
- 任意 bypass 标记。

Action Worker 必须重新查询 GitHub 事实并形成 `Main Write Guard` 结论。

中央 Main Write Audit 从 `AW_REPOSITORY_POLICY` 的受管仓列表动态发现仓库，不允许在 workflow 或脚本中硬编码项目名。Audit 必须对每个当前 main SHA 重新证明 provenance，而不能因为已有同名 success status 就跳过验证。

## 7. Downstream requirement

以下操作必须要求与目标 source SHA 精确绑定的 `Main Write Guard = success`：

- Release；
- Deploy；
- Publication；
- production / privileged execution；
- 任何可以把源码传播到正式运行或正式分发环境的任务。

不能以“分支名是 main”代替 Main Write Guard。

## 8. AI Review

AI Review 不属于 Main Write Guard，也不能参与其结论。

PR 的顺序为：

```text
Security / CI / PR deterministic gates
        ↓
validate-merge / PR Governance PASS
        ├──→ merge authority
        └──→ AI Review (advisory, asynchronous)
```

AI Review 可以在 Gate 通过后继续发现问题、提出建议、发布评论，但：

- 不得改变 `validate-merge`；
- 不得改变 `PR Governance`；
- 不得改变 `Main Write Guard`；
- 不得授予 Release / Deploy 权限；
- 失败、超时、模型不可用不得延迟或改变确定性 Gate。

## 9. 权限

Main Write Guard 自身只需要读取 GitHub 事实并发布受控状态。

AI Review 不得拥有 main 写权限、merge 权限、release 权限或 deploy 权限。

任何可以写 `main`、发布 Release 或执行 Deploy 的凭据都必须由独立确定性 Authority 控制。

## 10. 验收标准

治理闭环完成时必须满足：

1. 所有受管仓使用相同的 Main Write Guard 合同；
2. public 仓在平台允许时同时启用原生 PR-only 保护；
3. private 仓即使物理发生直接 push，非法 SHA 也不能进入正式产出链；
4. Release / Deploy 必须验证 Main Write Guard；
5. AI Review 位于确定性 PR Gate 之后且永远不成为 Gate；
6. 新增 Runner、仓库或产品不能绕开这条链。
