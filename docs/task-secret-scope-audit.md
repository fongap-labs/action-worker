# 任务密钥作用域只读诊断

此工具只用于排查已批准的任务 Secret 名称是否放在正确的 GitHub 配置作用域，**不读取 Secret 明文、不改变 Secrets、不修改工作流**。任务仍由原有必需值检查拒绝缺失的注入。Cloudflare Account ID 属于普通配置，应存为 GitHub Actions Repository Variable；中央任务策略通过 `variable_sources` 明确将该变量映射到任务代码读取的 `CLOUDFLARE_ACCOUNT_ID`，不应把它配置成 Secret。

## 已核查问题

2026-11-06 的中央工作流 #42173566146 与 #42173815239 在执行 FongapCDN 任务前失败，日志报错 `A required task Secret slot has no value.`（退出码 77）。固定来源提交中的 `projects/FongapCDN/.secrets.required` 声明两项必需名称，中央 `policies/task-secrets.json` 对应两个存储名称别名。失败时执行作业未绑定特定 GitHub Environment。

本次仅根据公开运行日志和仓库代码确定：至少一个已批准的必需槽位注入结果为空。不能据此断言 Secret 没有配置，也不能断言别名错误；还需核对 Secret 名称的仓库级、组织级授权及 Environment 作用域。

## 使用方式

在有权限的**本地受控终端**准备严格的名称清单，不包含任何 Secret 值；请勿在公共 CI 中自动生成、上传或打印该清单：

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

其中 `repository` 为 Action Worker 仓库级 Secret 名称；`organization_accessible` 必须仅记录**已确认授权 Action Worker 使用**的组织级名称；`environments` 为实际环境名称与其中的 Secret 名称。名单不全时保持 `coverage: partial`，不能声称某项确实不存在。只有三类名称作用域均核实完整时才可以标记 `complete`。

将来源仓库对应**固定提交**检出至本地目录，并在 Action Worker 仓库根目录运行：

```bash
node scripts/audit-task-secret-scope.ts /path/to/pinned-source fongap-labs/internal-vault FongapCDN <40位完整源码提交SHA> /path/to/names-only.json
```

工具会先检查本地来源目录的 Git HEAD 与指定的 40 位提交 SHA 完全一致，并拒绝改动或新增的项目密钥声明文件（`.secrets.required`、`.secrets.allowed`）；不允许用 `main`、标签或短 SHA 替代。固定提交 SHA 应来自已经核实的任务派发记录，而不是凭当前默认分支推测。

输出只含分类数量，不输出来源路径、项目、Secret 名称或值。它会根据现有中央策略及来源声明重新验证槽位，分为仓库级名称匹配、已授权组织级名称匹配、仅 Environment 可见及清单未覆盖的项。

**仅 Environment 可见并不能让未指定 `environment:` 的作业使用该 Secret。** 名称匹配也不能证明 Secret 值非空、权限有效、近期未撤销或运行时成功注入。所有结果都固定标记为 `UNVERIFIED`，不得用于跳过原有运行时拒绝逻辑。

## 下一步

由授权维护者在 GitHub 管理界面核对两个必需存储名称的存在性及其实际作用域，必要时修正配置并单独审批。禁止直接搬运任何生产 Secret 值到日志、任务输入或公开 PR。此项诊断与私有任务隔离生产切换准入互相独立；私有隔离仍保持禁止切换。
