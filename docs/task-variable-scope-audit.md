# 任务变量作用域离线只读诊断

此工具补充 [Secret 作用域审计](task-secret-scope-audit.md)，专门检查 `#1550` 中的 GitHub Actions Variable 名称可达性；它**不读取变量值、不调用 GitHub 管理 API、不修改 Variable、Secret、Environment 或任何工作流**。

## 受控操作

由具有对应管理权限的维护者在授权的私有终端，按仓库级、组织级且已授予 Action Worker 仓库访问权限、Environment 级分别核对**Variable 名称**，仅在本地创建名称清单（不得包含值、API Token 或完整私密配置）：

```json
{
  "schema_version": 1,
  "coverage": "partial",
  "repository": [],
  "organization_accessible": [],
  "environments": {
    "production": []
  }
}
```

- 未能独立核实全部适用作用域时，保持 `coverage: partial`；不得将未知误报为不存在。
- `organization_accessible` **只包含确实允许 Action Worker 仓库读取的名称**；仅在组织中存在但未授予该仓库的 Variable 不应列入。
- `environments` 为实际 Environment 及其 Variable 名称。未在 `Execute task` 作业声明的 Environment 中的 Variable **不能视为可注入该作业**。
- 这个文件属于受控审计输入，不得上传 Actions Artifact 或提交仓库。名称匹配无法证明 Variable 值非空、当前工作流注入成功或被授权使用。

获取**真实已核实的失败派发**中使用的完整 40 位来源 SHA，并将来源仓库准确检出到该固定提交后，在 Action Worker 根目录运行：

```bash
node scripts/audit-task-variable-scope.ts \
  /path/to/pinned-source \
  fongap-labs/internal-vault \
  FongapCDN \
  <full-40-character-source-sha> \
  /path/to/variable-names-only.json
```

工具先验证 Git HEAD 与固定 SHA 一致，并拒绝项目的 `.secrets.required` / `.secrets.allowed` 被修改或另加未跟踪声明，然后按当前中央 `policies/task-secrets.json` 还原受管 `kind: variable` 的必需映射。输出只报告：必需 Variable 数量、别名数量、仓库/已授权组织/仅 Environment 名称匹配数、未覆盖计数，不暴露名称及值。

工具固定返回 `status: UNVERIFIED`、`actual_variable_values_checked: false`、`runtime_injection_proven: false`。不在 GitHub Actions 中运行；在 Actions 环境会直接拒绝。

## 已确认的源码注入链缺陷

在 `resolve-task-secret-plan.ts resolve` 中，先前未传入已经由 `export-repository-variables.ts` 写入 GitHub 作业环境的 Variables，导致计划构建时一律按空环境检查必需 Variable。即使配置存在，`CLOUDFLARE_ACCOUNT_ID_PRIMARY` 也会在真正执行前被拒绝。修复后计划解析读取现有作业环境；这是代码修复，**不能反推管理员配置实际存在或值非空**。必须以修复合并后针对固定来源提交的真实受控执行日志重新判定 #1550，不得把原先的失败当作配置缺失证明。

## 中央无人值守漂移识别

Action Worker 现有 `audit-config-scope.yml` 已按主分支策略变更和每日调度运行。本轮在既有只读 `config-storage-audit.ts` 中检测四个批准 Task 项目共用的 Account ID 来源：比较 Action Worker Repository / 已授权 Organization Variables 与 `internal-vault-ops` Environment Variables 的**名称元数据**，不读取或保存 Variable 值。

报告只输出 `task_ops_account_id_scope` 的来源类别与 `drift_detected`。`protected-ops` / `job-context` 表示目前只有一个可辨认来源；`duplicate-sources` 表示两个来源均存在，可能产生遮蔽与配置漂移；`missing` 表示完整可读的作用域中均未找到；组织或 Environment 权限不可读时为 `unverified`，漂移结果为 `null`，**不得解释成配置不存在**。明确识别到重复或缺失时，现有审计作业生成不含名称、值或账户标识的警告，不自动迁移或扩权。

名称可见不代表变量值有效、工作流可注入或任务成功；四个 Task 项目的真实 Runner 验收和最小权限调整仍按 #1550 未完成事项单独处理。

## 后续验收

对于 `CLOUDFLARE_ACCOUNT_ID_PRIMARY`：若名称仅在某 Environment 出现，应先独立审核当前任务是否应有该环境绑定，而不是直接将 Environment 加到高权限作业；若不存在或组织未授权，先走最小权限审批。若名称可见，也不表示 Variable 值已被注入。**必须在批准的试点运行中保持原必需槽位 fail-closed 校验，并取得真实成功证据**，随后分别关闭 #1550 和 #1478 的核查。禁止把 Variable 迁回 Secret、在日志打印值或用伪造环境变量让生产任务变绿。
