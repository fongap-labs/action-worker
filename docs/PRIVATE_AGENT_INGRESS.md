# 私有任务入口

## 目的

任何已授权的 Agent（Claude Code、Codex、OpenCode、H2O 或其他工具）都可以通过 **GitHub 原生 workflow_dispatch** 请求执行已有的受管任务。实际运行与 GitHub 写操作由 Action Worker 和 fongap-bot 负责。

**共享的 `fongap-labs/mcp-hub` 不提供这个入口，不保存执行令牌，也不在普通 GitHub MCP 工具列表中暴露 fongap-bot 的调用能力。** 其他 MCP 用户即使能访问共享 Hub，也不能借助 Hub 的 `github_create_issue` 触发这个工作流。

## 调用方法

先使用获准的 GitHub 用户身份登录 `gh`。不要把 GitHub App 私钥、运行时令牌或 PAT 放进提示词。

```bash
gh workflow run agent-task-ingress.yml \
  --repo fongap-labs/action-worker \
  --ref main \
  -f repository=fongap-labs/ai-gateway \
  -f project=<仓库中已有的受信任项目>
```

也可以通过 GitHub REST `POST /repos/fongap-labs/action-worker/actions/workflows/agent-task-ingress.yml/dispatches` 调用，输入仍只有 `repository` 和 `project`。所有 Agent 都遵循同一接口，不直接调用中央的 `run-task` 事件。

## 强制保护

1. 仅接受 GitHub 原生 `workflow_dispatch`，且必须在 `fongap-labs/action-worker` 的 `main` 上运行。
2. GitHub 自己提供的 `GITHUB_ACTOR` 与 `GITHUB_ACTOR_ID` 必须同时匹配 `policies/agent-ingress.json` 中明确批准的账号。重跑者与原始发起人不同则拒绝。
3. 只接受 `repository` 和 `project` 两个字符串；不接受模型选择、shell 命令、执行脚本、令牌、任意工作流名称、分支 SHA 或覆盖门禁的字段。
4. 目标仓库必须在既有 `policies/repository-access.json` 中有 `task` 授权，并具有活跃 `main` 分支。GitHub App 使用单独的短期只读令牌获取目标 `main` SHA。
5. 完成以上检查后，才签发仅授权 `action-worker` 仓库 Contents:write 的短期 App 令牌，通过原有 `run-task` 合同提交；验证与执行不共享写令牌。
6. 原有任务运行器仍重复验证当前默认分支 SHA、CI Evidence、Main Write Guard、项目清单和执行权限。此入口不得降低原有安全要求。
7. 已有的 `delta-legacy` 冻结/排除政策不变；该入口不自动授予任何仓库新能力。

## 边界与后续

- 这个版本只让不同 Agent **统一触发已有、可信 main 中定义的任务项目**，并没有把任意自然语言请求变成自动编程任务。
- GitHub 接受 dispatch（HTTP 204）仅代表任务已发送，**不代表执行完成**。最终结果在 `自动 · 任务分发` 工作流中查看。
- 任何得到批准的 GitHub 用户登录凭据的程序都可能以该用户身份调用本入口；必须由用户在各 Agent 客户端中独立管理凭据，不能把这样的凭据授权给共享 MCP 用户。仓库不能替代凭据本身的保护。
- 后续如要实现任意自然语言任务、自动编程和轮询状态，应在独立的私有 Agent 入口上增加明确授权的执行合同；不得重新把这组工具加入共享 MCP Hub。

## 配置说明

当前已配置 `fongap` GitHub 用户为唯一允许的发起账号。若更改允许的账号，必须经维护者明确批准并通过原有 `validate-merge` 门禁。不要让 Agent 自行修改此名单或关闭校验。

本改动不新增 GitHub PAT/Secret、不部署新 MCP 服务、不改变共享 Hub 权限，也不修改主分支保护规则。
