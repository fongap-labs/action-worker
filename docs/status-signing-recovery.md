# 签名密钥初始化恢复

当 Main Write Guard、中央 CI、任务分发同时出现 `AW_STATUS_SIGNING_KEYS is required to sign commit statuses` 时，不能通过跳过校验或恢复无签名状态来消除红叉。必须初始化新的独立 HMAC 签名密钥，并保留 `AW_STATUS_TOKEN` 对历史 `aw1` 状态的验证材料。

## 一、先补管理权限

此操作必须由有权限管理 `fongap-labs/action-worker` 的管理员执行。

1. 检查 `action-worker → Settings → Secrets and variables → Actions → Repository secrets` 是否存在 `AW_ADMIN_TOKEN`，以及 `AW_STATUS_TOKEN` 是否仍然存在。**不要删除或更换 `AW_STATUS_TOKEN`**，否则历史验签将失去依据。
2. 确认 `AW_ADMIN_TOKEN` 对 **仅** `fongap-labs/action-worker` 仓库有 **Secrets: Read and write** 权限。如果是 Fine-grained PAT，请检查令牌持有人、仓库选择、到期时间和组织审批；如果是 GitHub App，请确认安装方已批准相应仓库权限。权限不足时的 HTTP 403 与限流并不是同一种故障。
3. 由管理员按组织的密钥托管流程更新 Repository Secret `AW_ADMIN_TOKEN`。不要在 Issue、PR、Actions 日志或聊天中粘贴令牌值。仓库设置与 AI Review 变量仍使用此凭据，调整范围时需要保留它们原有的必要权限。

## 二、只运行签名初始化

在有该功能的 `main` 合并后：

1. 打开 **Actions → 手动 · 恢复签名密钥**。
2. 选择 **Run workflow**，分支设为 `main`。
3. 勾选 `confirm`，明确确认只恢复缺失的签名密钥且保留历史验签。不要在输入中粘贴任何令牌或密钥。
4. 提交运行。如 `admin-ops` 环境需要审批，由有权审核的维护者批准。
5. 查看 **Bootstrap missing CI evidence signing keys** Job。成功后，脚本会设置 Repository Secret `AW_STATUS_SIGNING_KEYS` 并发送 `run-intake`，随后新运行才能读取更新后的 Secret 快照。

这个恢复入口只在 `main` 上运行，不修改其他仓库设置，且密钥环已经存在时会拒绝重复初始化。原来的 **自动 · 仓库设置** 仍只接受 `push` 和 `schedule`，保持原有治理触发规则。

## 三、验证结果

检查 `action-worker → Settings → Secrets and variables → Actions` 已出现 `AW_STATUS_SIGNING_KEYS`（无需查看 Secret 的实际值）。再检查新产生的 Main Write Guard、主分支审计和中央 CI 运行，确认不再因缺少签名密钥失败。

历史 `aw1` 状态继续由新密钥环里的 `legacy_tokens` 材料验证。不能为了让旧 CI 状态变绿而删除历史证明、关闭校验、覆盖已有失败结论或强制合并。

如果仍返回 **HTTP 403**，检查专属凭据的 Secrets 权限和组织授权；如果返回 **HTTP 429** 或限流提示，不应不断重新生成密钥，应按 GitHub API 限流策略处理。
