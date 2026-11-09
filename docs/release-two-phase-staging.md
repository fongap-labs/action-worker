# 两阶段发布：受控非生产接线（默认禁用）

此模块服务于 [AW-008](proposals/AW-008-changelog-release-automation.md) 和 #1495 的阶段一验收。**它不是生产发布路径已切换的声明**。当前 `handle-release-dispatch.yml` 没有设置两阶段 opt-in，也未授予 `pull-requests:write`；生产仍采用只读目标 CHANGELOG、直接生成 GitHub Draft Release 的原行为。

## 受控激活门槛

`policies/release-two-phase-staging.json` 当前 `approved_staging_repositories` 为 **空数组**，在没有新治理 PR 明确批准某个试点仓库前，任何 Two-phase mode 都无法创建目标 Release PR。

试点所需三项独立准入条件：

1. 通过独立治理 PR 把**明确的非生产目标仓库**加入 `approved_staging_repositories`。不得把生产仓库或通配符放入；仅允许 `owner/repository` 完整标识，不接受重复和非法名称。
2. 在另外获批的受保护 staging 运行环境显式注入 `AW_RELEASE_TWO_PHASE_MODE=staging`、`AW_RELEASE_PR_WRITE_API_TOKEN`（**仅限目标仓库**，需 `contents:write` 和 `pull-requests:write`）及 `AW_RELEASE_PR_STATUS_API_TOKEN`（**仅限目标仓库**，最小 `statuses:read`）。这两个 token 不得复用不相干的源仓库 token，不得写入仓库、工作流日志或 PR 描述；需要先审查目标 App 实际安装与权限。
3. 试点必须使用另外受控配置的运行/审批链路，满足真实 target CI、签名 `validate-merge`、Main Write Guard、合并 SHA 与 tag 一致性要求。不要未经审批修改现有生产 `handle-release-dispatch.yml` 的权限或向其中直接加入 staging 变量。

若 mode 不存在、为空或为 `read-only`，仍执行原先的只读 Release 路径。若 mode 为其它值、目标仓库不在受审白名单内、缺少独立目标 PR/状态凭据，**在创建任何 Release PR 前拒绝**，不降级到高权限的隐式后备 token。

## 两阶段受控代码路径

在所有既有 request/CI Evidence、Main Write Guard、产物 SHA-256、目标 App 作用域及 Release tag 冲突验证完成后，staging 模式会调用 `publishChangelogRelease`，在目标仓库创建或恢复 `aw/changelog/<tag>` PR。该 PR 只有通过**签名且来源可信的** `validate-merge` 与合并提交 Main Write Guard 后才能返回 `mergeSha`。随后使用此 `mergeSha`，而非阶段一之前的 target SHA，作为 Draft Release 的 `target_commitish`；若 manifest 没有提供显式 release_notes，采用合并后版本小节。

阶段一重试必须继续核验 PR 身份和同一截止时间。staging 限制阶段一总预算为 12 分钟；当前生产 Workflow 只有 20 分钟作业上限，且包含产物下载、验证、Release 上传等步骤，**尚不能以现有生产作业的时限证明真实 E2E**。未来试点需单独审查独立 Job 超时、取消与恢复策略，不能因为 staging 代码存在就自动放行。

## 不得宣称完成的验收项

仍需真实非生产环境证据：阶段一生成 PR → 正常中央 CI → 签名合并门禁 → Main Write Guard → tag 指向本次 PR merge SHA → Draft Release 资产与 checksum 校验 → 正式发布，以及关闭/取消、重复触发、网络失败、未合并 PR、权限不足、发布失败后重试和回滚场景。生产 App 权限、Secret 及目标仓库规则尚未在此源码 PR 中调整；没有实际资源被部署、没有 Release 被创建。

