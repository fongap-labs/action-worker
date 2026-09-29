# Runner Policy

本文档定义 Action Worker 的 Runner 抽象、选择与信任边界。

## 1. Runner ownership

Runner 属于 Action Worker 执行平面，不属于业务仓。

业务仓只声明 `runner_profile`，不得直接指定：

- GitHub-hosted Runner 镜像名；
- self-hosted label；
- Runner group；
- 某台服务器、主机名或云实例；
- Runner fallback 顺序。

实际 Runner 由 Action Worker 根据 Policy 解析。

## 2. Runner profiles

Runner Profile 表达执行需求，不表达基础设施实例。

建议长期使用通用 profile，例如：

```text
linux-standard
windows-build
macos-build
arm64-linux
trusted-deploy
```

具体 profile 集合由机器 Policy 管理；业务仓不得为了某个仓库创建专属 profile。

## 3. Backends

Action Worker 至少允许两类 Runner Backend：

```text
github-hosted
self-hosted
```

未来增加其他计算后端时，应扩展 Runner Resolver，而不是修改业务仓 Manifest。

Self-hosted 是正式预留后端，不是例外路径。

## 4. Resolution

```text
runner_profile
  ↓
Runner Policy
  ↓
trust / os / arch / resource / network requirements
  ↓
Runner Resolver
  ↓
actual backend and runner
```

例如：

```text
linux-standard
→ GitHub-hosted Linux

arm64-linux
→ eligible ARM backend

trusted-deploy
→ trusted runner with required private-network access
```

以上只是语义示例，不构成固定实现映射。

## 5. Trust domains

Runner 选择必须遵守信任域，而不是只按性能选择。

至少区分：

```text
sandbox
control
privileged
```

### Sandbox

允许执行不可信项目代码、PR 代码、build 和 test。

不得持有：

- 中央管理 Token；
- AI Gateway 管理凭据；
- 生产部署凭据；
- 非必要跨仓写权限。

### Control

允许执行治理、规划、证据处理和受控 API 操作。

不得直接执行不可信 PR 代码。

### Privileged

仅用于明确需要生产网络或生产凭据的受控操作，例如生产部署。

Privileged 任务必须 fail closed，不得因为目标 Runner 不可用而自动降级到更低信任等级。

## 6. Fallback

Runner fallback 由中央 Policy 决定。

只有安全属性等价时才允许自动 fallback。

例如：

- 普通无 Secret Linux build 可以在等价计算后端之间切换；
- 需要私有网络或生产 Secret 的部署不得自动 fallback 到普通 GitHub-hosted Runner；
- 架构不匹配时不得通过模拟“成功”继续执行。

## 7. Self-hosted boundary

Self-hosted Runner 必须被视为可替换计算资源，而不是业务架构的一部分。

业务仓不得依赖：

- Runner hostname；
- 本地固定目录；
- 预装但未声明的工具；
- 人工维护的长期工作区状态；
- 仅某台机器存在的 Secret。

Self-hosted 执行必须尽可能保持：

```text
ephemeral workspace
explicit dependencies
least privilege
clean checkout
controlled cache
auditable provenance
```

## 8. Secrets

Secret 注入由 Action Worker 根据 Capability Grant 与信任域决定。

业务 Manifest 不得指定 Secret 名称。

Runner 只能获得完成本次任务所需的最小凭据；任务结束后不得把 Secret 写入 artifact、cache、log 或项目工作区。

## 9. Scheduling boundary

CI、build、review、release、deploy、task 与 scheduled job 都通过同一 Runner Resolver 选择后端。

不得出现：

```text
CI 有一套 Runner 选择
Release 有第二套
Deploy 再硬编码第三套
```

不同 operation 可以提出不同需求，但底层解析机制必须统一。

## 10. Migration

当前 workflow 中直接使用 `runs-on` 的实现可以在迁移期继续存在，但长期应由中央 Runner Policy 收敛。

新增业务仓不得新增独立 Runner 策略。

验收标准：

> 替换 GitHub-hosted Runner、增加 self-hosted Runner 或迁移计算基础设施时，业务仓无需修改执行逻辑。

## 11. PR dispatcher runner extension

业务仓可以使用已批准的最薄 PR 触发器 `templates/pr-dispatcher/dispatch-pr-governance.yml`，让 PR 事件在一分钟量级内到达中央治理。它运行在控制域，只发送提示，不检出也不执行任何 PR 代码。

Runner 选择遵守第 1 节：业务仓的工作流文件里没有任何 runner 名称或标签，`runs-on` 读取由中央管理的仓库变量：

```text
runs-on: ${{ fromJSON(vars.AW_DISPATCH_RUNS_ON || '"ubuntu-24.04"') }}
```

- 变量未设置时使用 GitHub-hosted Linux。
- 中央 Policy 提供两个控制域 profile：`control-standard`（GitHub-hosted）与 `control-self-hosted`（默认 `enabled: false`，fallback 到 `control-standard`）。
- 变量值只由 `node scripts/resolve-dispatcher-runs-on.ts <profile>` 生成；该脚本拒绝 sandbox 与 privileged profile。

为某个仓库启用 self-hosted（消耗的是自己的算力，不占 GitHub-hosted 分钟）：

```bash
gh variable set AW_DISPATCH_RUNS_ON --repo fongap-labs/<repo>   --body "$(node scripts/resolve-dispatcher-runs-on.ts control-self-hosted)"
```

边界：

- 只用于私有仓库。不要为公开仓库注册 self-hosted runner：fork PR 的工作流可能把代码调度到它上面。
- runner 离线时 GitHub 不会自动回退，作业会一直排队；治理仍由中央 intake 兜底，受影响的只是速度，不是安全性。
- 该文件受安全闸门的 `approved_workflows` 保护：路径加内容哈希必须与批准模板逐字节一致，任何改动都会让它重新受 `pull-request-target` 规则约束。
- Dependabot 无法读取 Actions secret，触发器对它们直接跳过，由中央 intake 处理。
