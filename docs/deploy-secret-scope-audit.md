# 部署密钥作用域离线只读诊断

本工具用于排查受保护部署作业的必需 Secret 名称与 GitHub Actions 配置作用域，不读取 Secret 值，不创建、修改或迁移凭据，也不启动部署。参见 [部署运维手册](06_RELEASE_DEPLOY_GUIDE.md) 与 [任务密钥作用域诊断](task-secret-scope-audit.md)。**仅对已批准的受控管理员终端开放，不允许在 GitHub Actions 或公开工件中运行。**

## 适用故障

#1495 的部署作业已通过来源请求验证，但在 `Stage authorized deployment Secrets` 阶段以退出码 77 拒绝，提示 `Required deploy Secret is unavailable: AIG_DEPLOY_HEALTH_KEY.`。执行作业已有一个明确的 `environment:` 绑定。单凭日志不能判断其存储名称缺失、仅属于另一 Environment、组织访问授权不足还是值为空。

本工具将**当前执行 Environment 的名称**与其他 Environment 明确区分。仅匹配当前 Environment、仓库级或者已向 Action Worker 仓库授权的组织级 Secret 名称，才有可能注入当前部署作业；同名出现在其他 Environment 不构成当前作业可达的证据。即便名称匹配，也不能证明 Secret 值非空或真正运行时可达。

## 输入

有权维护者在受限终端核对配置的**名称和适用作用域**，形成仅包含名称的本地文件：

```json
{
  "schema_version": 1,
  "coverage": "partial",
  "repository": [],
  "organization_accessible": [],
  "environments": { "production": [] }
}
```

`repository` 指 Action Worker 仓库 Secrets；`organization_accessible` 仅包含**授权该仓库读取**的组织 Secrets；`environments` 列出已独立核实的 Environment Secret 名称。Cloudflare Account ID 等已批准的 Actions Variable 不应被填入 Secret 清单。不能完整审核全部适用作用域时保持 `coverage: partial`，不能因清单未含某个名字就宣布它不存在。

源仓库必须检出到真实部署派发所引用的**完整不可变源码提交 SHA**，不得取当前 `main` 代替。根项目的密钥声明位于 `.github/deploy.secrets.required` 与 `.github/deploy.secrets.allowed`；多产品项目位于 `projects/<product>/` 下。工具检查 `git HEAD` 等于给定提交 SHA、上述声明文件没有修改或未跟踪副本，且每个现存声明都是受限大小的普通文件，不得是符号链接。

## 离线执行

在 Action Worker 本地可信检出目录根部执行，`-` 表示源仓库根项目：

```bash
node scripts/audit-deploy-secret-scope.ts \
  /path/to/pinned-source \
  fongap-labs/ai-gateway \
  production \
  - \
  <full-40-character-source-sha> \
  /path/to/deploy-secret-names-only.json
```

工具按当前中央 `policies/deploy-secrets.json` 和固定源码声明解析必需的 Secret/Variable 别名。由于真实 Variable 的值无须、也不得在名称审计中读取，离线解析阶段仅对政策批准的 Variable 名称使用内部占位符来恢复**名称绑定**；生产作业原有必需值验证不变，也不能用此工具的输出作为放行凭据。

只输出统计字段：必需 Secret 总数、别名数量、仓库级匹配、组织级匹配、**本次受保护 Environment 匹配**、仅其他 Environment 可见、完整清单缺失数量（或不完整清单中的未知数量）。不输出来源项目、Secret 名称、清单内容或任何值。固定返回 `status: UNVERIFIED`、`actual_secret_values_checked: false`、`runtime_injection_proven: false`、`deployment_success_proven: false`。

## 验收边界

若确认需更改 GitHub 仓库、组织或 Environment Secret 配置，必须在其独立权限域走最小授权审批。不得因数值匹配就复制生产密钥到仓库级、自动绑定更高权限 Environment、替换专属健康检查密钥或关闭 fail-closed 检查。

完成名称作用域核查后，还必须在受批准的非生产环境执行部署、健康检查、失败回滚和 Main Write Guard/CI 验证，并保留真实运行链接。**此离线审计只是根因排查准备，不是生产部署 E2E 证据。**
