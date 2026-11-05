# 状态签名密钥环迁移

将 Action Worker 的状态签名密钥配置名称由 `AW_STATUS_SIGNING_KEYS` 调整为三段式的 `AW_STATUS_KEYRING`，不改变签名算法、密钥数据或历史验签依据。

迁移必须分为两个独立阶段，禁止凭空重新生成替代旧密钥，也不提供运行时 Secret 或 Token 自动回退。

## 第一步：只验证，不切换

管理员在 `action-worker` 的 Repository Secrets 中配置 `AW_STATUS_KEYRING`，其中须包含与现有 `AW_STATUS_SIGNING_KEYS` **完全一致**的活动密钥、历史密钥和 `legacy_tokens`。

本阶段为 `自动 · 仓库设置` 增加独立的 `Verify status keyring migration` Job，运行于受保护的 `admin-ops`。只比较两个 Secret，不修改它们，也不在日志中输出任何密钥材料。

如果新密钥环的内容无效、缺失、与旧密钥不同或丢失历史验签材料，Job 必须失败。原有 CI 继续从 `AW_STATUS_SIGNING_KEYS` 读取，不受校验失败影响。

## 第二步：切换唯一配置

只有第一阶段通过后，才将工作流、签名工具、初始化脚本、测试与文档统一切换为 `AW_STATUS_KEYRING`，确保不保留任何旧配置作为运行时回退。再次验证中央 CI、Main Write Guard、历史签名和任务调度。

最后确认旧名称无人引用之后，管理员才能删除 `AW_STATUS_SIGNING_KEYS`。**在完成第二阶段验证之前不得删除旧 Secret**。
