# 历史任务工件元数据只读审计

本工具用于补充私有任务隔离切换前的运行证据，不执行迁移或启用试点。

在拥有 `Actions: Read` 权限的受控终端，从 Action Worker 仓库根目录执行：

```bash
GH_TOKEN=<只读凭据> GITHUB_REPOSITORY=fongap-labs/action-worker node scripts/audit-private-task-artifacts.ts
```

工具从 `policies/task-secrets.json` 枚举当前普通任务准入候选，按现有状态工件命名算法只查询 GitHub Actions 工件元数据及其关联运行记录。不调用工件下载接口，不读取任务日志，不解密状态，不读取或修改 Secrets，也不触发工作流。

输出使用不可逆截短哈希标识候选项目，仅包含工件数量、关联运行编号、来源工作流与成功状态的核对结果。运行编号仍属于可关联的元数据，因此输出应仅留在受限审计记录，不在公开 CI 中自动执行。

**重要限制：** 结果始终标记 `INCOMPLETE`，即使工件查询未截断也不能据此确认恢复成功。每个候选工件最多检索三页，每页一百条；若超过上限，`artifact_listing_complete=false`。GitHub API 出错时中止，不将错误当成无历史工件。该工具无法从运行元数据还原 `repository_dispatch` 载荷中的固定提交，无法枚举外部写入者或证明跨入口互斥，也不能验证加密工件能够恢复。

下一步由项目维护者在受控环境核实实际运行记录、历史工件保留期限、确切任务来源与所有写入入口。生产切换仍然禁止，已有门禁不得放宽。
