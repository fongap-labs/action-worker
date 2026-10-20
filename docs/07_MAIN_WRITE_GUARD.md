# Main Write Guard

本文件定义受管仓库 `main` 分支写入来源的边界。

**语言规则**：工程产出（PR 标题、CHANGELOG 条目、代码注释、工作流、日志、错误信息、测试描述、配置键）必须使用英文。详见 `01_SHARED_GOVERNANCE.md` §2。

---

## 1. 目标

每个受管仓库，无论公开还是私有，都遵循：

```
只有通过确定性门禁的 PR，
才能产生可信的 main SHA。
```

长期目标不是“检测直接 push”，而是确保一个无法证明来自合法 PR 合并的 `main` SHA，永远不能进入任何正式的执行链。

---

## 2. 两道门禁

```
进入 main 之前
  validate-merge
  = 合并资格

main 更新之后
  Main Write Guard
  = main 来源证明
```

`validate-merge` 决定 PR 能否合并。对于受管业务仓库，它是 Action Worker 直接发布的中央提交状态，不依赖业务仓库的 GitHub Actions。Action Worker 自身的 self-CI 可以在本仓库中继续使用同名检查。

`Main Write Guard` 验证 `main` 的当前 SHA 确实由一个通过了治理并合并进 `main` 的 PR 产生。

这两项职责不能合并，也不能互相替代。

---

## 3. 合法的 main 写入

Main Write Guard 只依据 GitHub 上的当前事实重新验证；它从不信任 commit message、调用方参数或本地状态。

长期的最低条件：

```
仓库受管
head SHA 不可变
head SHA 关联到一个已合并的 PR
PR 的 base 是 main
PR 的合并结果与 main 的更新一致
该 PR/head 已通过所需的确定性门禁
```

实现要适配仓库当前允许的合并方式。对于 Fongap Labs 目前普遍使用的 squash 合并，必须验证 GitHub 返回的已合并 PR 与目标 `main` SHA 之间的真实关系。

以下任何一项都不能单独证明合法性：
- commit message
- actor 名称
- 分支名称
- 工作流输入
- 自报的 PR 编号
- 自报的 `validate-merge` 结果

---

## 4. 不合法的 main 写入

如果 Main Write Guard 无法证明当前 `main` SHA 来自合法的 PR 合并，该 SHA 被标记为不可信。

```
直接 push / 未知写入
        ↓
Main Write Guard = failure
        ↓
main SHA = untrusted（不可信）
        ↓
拒绝 Release
拒绝 Deploy
拒绝 Publication
拒绝特权任务
```

在 GitHub 平台无法提前阻止直接 push 的仓库中，工作流仍然失败即关闭：未经证明的 SHA 永远不能获得任何正式输出的能力。

是否自动回滚不合法的写入，属于执行策略，不能替代这一信任判定。即使自动回滚失败，不可信的 SHA 也不能被发布或部署。

---

## 5. 公开仓库与私有仓库

### 平台强制可用

当 GitHub rulesets / 保护分支可用时：

```
要求 pull request
+ 要求中央 validate-merge 状态
+ 无绕过主体
+ 限制直接更新 main
```

GitHub 会在写入之前拒绝不合法的路径，而 Main Write Guard 仍是第二道来源证明。

### 平台强制不可用

当当前 GitHub 套餐无法为私有仓库提供等效的强制保护时：

```
直接写入 main 可能实际发生
→ Main Write Guard 必须失败
→ 结果 SHA 被隔离
→ 每个特权的下游路径都必须拒绝它
```

平台功能的差异不得产生第二套治理模型。

---

## 6. 工作流边界

Main Write Guard 的安全性不得取决于业务仓库的 Actions 是否能运行。

权威基线是公开的 `action-worker` 中的中央 Main Write Audit（`scripts/audit-main-writes.ts`），由 Intake 的 `Main write audit` 作业、Central CI 的 follow-up 作业，以及 Release / Deploy / Task 入口在校验前运行。它重新读取受管仓库的当前 `main`，并独立验证来源。即使业务仓库没有 Actions 分钟数、桥接已被删除，或直接 push 同时修改了它的工作流，不合法的 SHA 也不能获得信任。

业务仓库的桥接 `notify-action-worker.yml` 在 `main` 有 push 时只发送不带任何字段的 `run-intake` 事件，作为实时加速手段；它不是安全前提，且绝不能单独产生可信结论。

`main-write-guard.yml` 只证明 Action Worker 自身 `main` 的每次 push，使用工作流令牌与本地 `validate-merge` 检查。

调用方不得提交：
- “这是合法合并”的布尔结论
- PR 门禁结果
- 发布或部署授权
- 密钥
- 任何绕过标记

Action Worker 重新查询 GitHub 事实，并自行形成 `Main Write Guard` 的结论。

中央 Main Write Audit 从 `AW_REPOSITORY_POLICY` 中的受管仓库列表动态发现仓库；项目名称不得硬编码在工作流或脚本中。审计必须对每一个当前的 main SHA 重新证明来源，不得仅因为已存在同名的成功状态就跳过验证。

---

## 7. 下游要求

以下操作要求目标源 SHA 具有精确绑定的 `Main Write Guard = success`：

- Release
- Deploy
- Publication
- 生产 / 特权执行
- 任何可能把源码传播到正式运行环境或正式分发环境的任务

“分支名为 main”永远不能替代 Main Write Guard。

---

## 8. AI Review

AI Review 不属于 Main Write Guard，也不能参与其结论。

PR 的顺序为：

```
Security / CI / PR 确定性门禁
        ↓
Action Worker validate-merge / PR Governance 通过
        ├──→ 合并权限
        └──→ AI Review（仅供参考，异步）
```

门禁通过之后，AI Review 可以继续发现问题、提出建议并发表评论，但它：
- 不得改变 `validate-merge`
- 不得改变 `PR Governance`
- 不得改变 `Main Write Guard`
- 不得授予 Release / Deploy 权限
- 不得因失败、超时或模型不可用而延迟或改变确定性门禁

---

## 9. 权限

Main Write Guard 本身只需要读取 GitHub 事实，并发布受控的状态。

AI Review 不得拥有 main 写入、合并、Release 或 Deploy 权限。

每一个能够写入 `main`、发布 Release 或执行 Deploy 的凭据，都由独立的确定性权威控制。

---

## 10. 验收标准

当以下条件全部成立时，治理闭环才算完成：

1. 每个受管仓库都使用同一份 Main Write Guard 合同
2. 在平台允许的范围内，公开仓库同时启用原生的“仅允许 PR”保护
3. 在私有仓库中，即使直接 push 确实发生，不合法的 SHA 也无法进入正式输出链
4. Release / Deploy 会校验 Main Write Guard
5. AI Review 在确定性 PR 门禁之后运行，且从不成为门禁
6. 没有新的 Runner、仓库或产品可以绕过这条链路

---

## 11. 相关引用

- 语言与文档分层：`01_SHARED_GOVERNANCE.md` §2
- 仓库治理与合并权限：`02_REPOSITORY_GOVERNANCE.md` §3
- 业务仓库桥接模板：`05_INTEGRATION_GUIDE.md` §10.1
- Release/Deploy 下游要求：`06_RELEASE_DEPLOY_GUIDE.md` §3
- 共用治理宪法：`01_SHARED_GOVERNANCE.md` §5