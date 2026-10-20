# Runner 策略

本文件定义 Action Worker 的 Runner（运行器）抽象、Runner 选择与信任边界。

## 1. Runner 归属

Runner 属于 Action Worker 执行平面，而不属于业务仓库。

业务仓库只声明 `runner_profile`，并且绝不能直接写明：

- GitHub 托管的 Runner 镜像；
- self-hosted 标签；
- Runner 组；
- 某台具体的服务器、主机名或云实例；
- Runner 的回退顺序。

Action Worker 从策略中解析实际的 Runner。

## 2. Runner Profile

Runner Profile 表达执行需求，而不是基础设施实例。

当前启用的通用 Profile（权威定义见 `policies/runner.json`），例如：

```text
control-standard
linux-standard
windows-build
production-deploy
```

Profile 的具体集合由机器策略管理；业务仓库不得为某一个仓库创建 Profile。

## 3. 后端

Action Worker 至少允许两类 Runner 后端：

```text
github-hosted（GitHub 托管）
self-hosted（自托管）
```

将来增加其他计算后端时，扩展 Runner 解析器即可；业务仓库的清单无需修改。

Self-hosted 是正式保留的后端，而不是例外路径。

## 4. 解析

```text
runner_profile
  ↓
Runner Policy
  ↓
信任 / 操作系统 / 架构 / 资源 / 网络需求
  ↓
Runner Resolver（Runner 解析器）
  ↓
实际后端与 Runner
```

例如：

```text
linux-standard
→ GitHub 托管的 Linux

arm64-linux
→ 符合条件的 ARM 后端

production-deploy
→ 具备所需私有网络访问的受信任 Runner
```

以上只是语义示例，并不是固定的实现映射。

## 5. 信任域

Runner 的选择遵循信任域，而不是只看性能。

至少区分以下三类：

```text
sandbox（沙箱）
control（控制）
privileged（特权）
```

### 沙箱

可以执行不可信的项目代码、PR 代码、构建与测试。

不得持有：

- 中央管理令牌；
- AI Gateway 管理凭据；
- 生产部署凭据；
- 不必要的跨仓库写权限。

### 控制

可以运行治理、规划、证据处理与受控的 API 操作。

不得直接执行不可信的 PR 代码。

### 特权

仅用于确实需要生产网络或生产凭据的受控操作，例如生产部署。

特权任务失败即关闭，绝不会因为目标 Runner 不可用而降级到较低的信任级别。

## 6. 回退

Runner 回退由中央策略决定。

只有在安全属性等价的后端之间，才允许自动回退。

例如：

- 不含密钥的普通 Linux 构建，可以在等价的计算后端之间切换；
- 需要私有网络或生产密钥的部署，不得自动回退到普通的 GitHub 托管 Runner；
- 架构不匹配时，绝不能通过模拟"成功"继续执行。

## 7. Self-hosted 边界

自托管 Runner 是可替换的计算资源，不属于业务架构的一部分。

业务仓库不得依赖：

- Runner 的主机名；
- 固定的本地目录；
- 已预装但未声明的工具；
- 由人工维护的长期工作区状态；
- 只存在于某台机器上的密钥。

自托管执行应尽可能保持：

```text
临时工作区
显式声明的依赖
最小权限
干净的检出
受控的缓存
可审计的 provenance
```

## 8. 密钥

Action Worker 根据能力授予与信任域决定密钥注入。

业务清单不得声明密钥。

Runner 只接收完成本次任务所需的最小凭据；任务结束后，任何密钥都不得写入产物、缓存、日志或项目工作区。

## 9. 调度边界

CI、构建、审查、Release、Deploy、任务与定时作业，都通过同一个 Runner 解析器选择后端。

绝不能出现以下情况：

```text
CI 有一套 Runner 选择
Release 另有一套
Deploy 再硬编码第三套
```

不同的操作可以声明不同的需求，但底层的解析机制只有一套。

## 10. 迁移

迁移期间，直接使用 `runs-on` 的工作流可以继续保留，但长期应收敛到中央 Runner 策略。

新的业务仓库不得添加自己的 Runner 策略。

验收标准：

> 替换 GitHub 托管 Runner、新增 self-hosted Runner，或迁移计算基础设施，都不需要修改业务仓库中的执行逻辑。

## 11. 业务仓库桥接的 Runner 扩展

业务仓库使用已批准的最薄桥接 `templates/bridge/notify-action-worker.yml`，使 PR 事件与 `main` 的 push 在约一分钟内到达 Action Worker。它运行在控制域中，只发送通知，既不检出也不执行任何 PR 代码。

Runner 选择遵循第 1 节：业务仓库中的工作流文件不包含 Runner 名称或标签；`runs-on` 读取一个由中央管理的仓库变量：

```text
runs-on: ${{ fromJSON(vars.AW_DISPATCH_RUNS_ON || '"ubuntu-24.04"') }}
```

- 没有该变量时，使用 GitHub 托管的 Linux。
- 中央策略提供两个控制域 Profile：`control-standard`（GitHub 托管）与 `control-self-hosted`（默认 `enabled: false`，回退到 `control-standard`）。
- 变量的值只能由 `node scripts/resolve-dispatcher-runs-on.ts <profile>` 生成；该脚本拒绝沙箱与特权 Profile。

若要为某个仓库启用 self-hosted（使用自己的计算资源，不消耗 GitHub 托管分钟数）：

```bash
gh variable set AW_DISPATCH_RUNS_ON --repo fongap-labs/<repo>   --body "$(node scripts/resolve-dispatcher-runs-on.ts control-self-hosted)"
```

边界：

- 仅用于私有仓库。不要为公开仓库注册 self-hosted Runner：来自 fork PR 的工作流可能会被调度到该 Runner 上。
- 当 Runner 离线时，GitHub 不会自动回退，作业会保持排队；中央 Intake 仍然覆盖治理，因此只影响速度，不影响安全。
- 该文件受安全门禁中的 `approved_workflows` 保护：其路径与内容哈希必须与已批准模板逐字节一致；任何修改都会使其重新落入 `pull-request-target` 规则。
- Dependabot 无法读取 Actions 密钥，因此该触发器会跳过它的 PR，由中央 Intake 处理。
