# 状态签名密钥环迁移

将 Action Worker 的状态签名密钥配置名称由 `AW_STATUS_SIGNING_KEYS` 调整为三段式的 `AW_STATUS_KEYRING`，不改变签名算法、密钥数据或历史验签依据。

迁移必须分为两个独立阶段，禁止凭空重新生成替代旧密钥，也不提供运行时 Secret 或 Token 自动回退。

## 第一步：只验证，不切换（Verify Before Switching）

管理员在 `action-worker` 的 Repository Secrets 中配置 `AW_STATUS_KEYRING`，其中须包含与现有 `AW_STATUS_SIGNING_KEYS` **完全一致**的活动密钥、历史密钥和 `legacy_tokens`。

本阶段为 `自动 · 仓库设置` 增加独立的 `Verify status keyring migration` Job，运行于受保护的 `admin-ops`。先比较两个 Secret。如果不一致，将旧密钥环的完整内容经 GitHub Secrets API 安全写入新名称。仅允许受保护的 `admin-ops` 凭据执行，不在日志中输出任何密钥材料；旧 Secret 保持不变。

如果新密钥环格式无效或不一致，系统会从有效的旧密钥环复制。若旧密钥无效、Secret 不存在、权限不足或运行期间发生并发修改，则明确失败。复制成功后的新值只能在新排队的工作流中读取，必须再次运行校验确认一致。整个第一阶段原有 CI 仍从 `AW_STATUS_SIGNING_KEYS` 读取，不受迁移影响。

## 第二步：切换唯一配置（Switch Authoritative Configuration）

只有第一阶段通过后，才将工作流、签名工具、初始化脚本、测试与文档统一切换为 `AW_STATUS_KEYRING`，确保不保留任何旧配置作为运行时回退。再次验证中央 CI、Main Write Guard、历史签名和任务调度。

最后确认旧名称无人引用之后，管理员才能删除 `AW_STATUS_SIGNING_KEYS`。**在完成第二阶段验证之前不得删除旧 Secret**。

## 切换后的处置（Post-Migration Actions）

完成新名称上线且确认 Main Write Guard、中央 CI 和历史签名均正常后，可由管理员删除不再被工作流引用的旧 Secret。未完成验证时，旧 Secret 只保留用于回滚准备，不再作为运行时自动回退来源。
