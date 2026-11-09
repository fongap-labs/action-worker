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

在所有既有 request/CI Evidence、Main Write Guard、产物 SHA-256、目标 App 作用域及 Release tag 冲突验证完成后，staging 模式会调用 `publishChangelogRelease`，在目标仓库创建或恢复 `aw/changelog/<tag>` PR。该 PR 只有通过**签名且来源可信的** `validate-merge` 与合并提交 Main Write Guard 后才能返回 `mergeSha`。随后使用此 `mergeSha`，而非阶段一之前的 target SHA，作为 Draft Release 的 `target_commitish`；最终发布说明以**已合并且验签的 CHANGELOG 版本小节**为准；若 manifest 显式提供 release_notes，内容必须与该小节一致，否则 fail-closed，绝不通过 manifest 摘要覆盖受管 PR 的实际内容。

阶段一重试必须继续核验 PR 身份和同一截止时间。 合并后还必须在目标合并提交上查证目标 Release URL 对应的版本小节恰好出现一次、版本匹配；对 manifest 声明了专属条目的请求，版本小节中各类别的完整条目必须与本次 manifest 完全一致，防止同一 tag 的旧 PR 在不同请求之间被错误复用。staging 限制阶段一总预算为 12 分钟；当前生产 Workflow 只有 20 分钟作业上限，且包含产物下载、验证、Release 上传等步骤，**尚不能以现有生产作业的时限证明真实 E2E**。未来试点需单独审查独立 Job 超时、取消与恢复策略，不能因为 staging 代码存在就自动放行。

## 阶段一已合并后的精确重试

同仓库的传统、未显式声明 `changelog_entries` 的 Release，在阶段一 CHANGELOG PR 完成 squash 合并后，原受管来源 SHA 会落后于默认分支。若阶段二下载、上传或 Draft Release 校验失败，不能简单接受任意过期来源，也不能因为原来源过期就无法继续治理恢复。

现在仅在**已显式批准的 staging 模式**下，且源仓库和目标仓库相同、两次默认分支读取完全一致时，允许一条极窄的只读恢复前检：必须找到标题、tag、来源与目标分支都匹配、已关闭且已合并的原 Release PR，PR 的 `merge_commit_sha` 必须恰好是当前默认分支 HEAD；GitHub Compare 必须证明原来源 SHA 到当前 HEAD **恰好前进一个提交**，该提交仅修改受管 `CHANGELOG.md`；随后从两个固定 SHA 读取 CHANGELOG，按照原有版本条目治理要求验证精确升版，并与本次版本及 Release URL 匹配。全部通过才可继续调用原有阶段一函数做签名门禁及 Main Write Guard 的最终复验。

任何额外提交、非 CHANGELOG 变更、另一份 PR、缺失对比元数据、来源和目标 HEAD 之间出现并发变化，或者真实签名门禁不通过，均继续 fail-closed。Scoped mirror 项目维持原有的可信来源新鲜度检查，不得把此恢复通道推广成一般过期 SHA 白名单。当前 staging 白名单为空，本机制不会在生产触发。

## 失败时的保守恢复

在最终 `draft=false` 发布调用**发出之前**发生失败时，可清理本次新建且尚未提交发布的 Draft Release。调用一旦发出，HTTP 超时、连接重置或响应丢失都无法证明 GitHub 没有成功发布；此时**禁止自动删除 Release 和 tag**，保留现有资源，记录脱敏告警并由有权维护者核对 `releases/{id}` 的 draft 状态、`releases/tags/{tag}`、Git tag SHA 以及目标受管合并提交，再决定是否允许恢复或单独回滚。不得简单重放已成功发布的请求。

## 不得宣称完成的验收项

仍需真实非生产环境证据：阶段一生成 PR → 正常中央 CI → 签名合并门禁 → Main Write Guard → tag 指向本次 PR merge SHA → Draft Release 资产与 checksum 校验 → 正式发布，以及关闭/取消、重复触发、网络失败、未合并 PR、权限不足、发布失败后重试和回滚场景。生产 App 权限、Secret 及目标仓库规则尚未在此源码 PR 中调整；没有实际资源被部署、没有 Release 被创建。

