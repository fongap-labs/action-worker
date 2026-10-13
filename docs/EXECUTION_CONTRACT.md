# 执行合同

本文件定义受管的 Fongap Labs 仓库与 Action Worker 之间统一的执行边界。它适用于公开仓库与私有仓库，并且不随仓库可见性而变化。

## 1. 核心原则

```text
业务仓库
= 源码 + 项目脚本 + 执行意图（测试由 Action Worker 的测试包持有，见 TEST_PACKS.md）

Action Worker
= 治理 + 授权 + 规划 + 执行 + 证据 + provenance

Runner
= 可丢弃的计算后端
```

业务仓库描述"需要做什么"；Action Worker 决定"是否允许、如何运行、在哪一类 Runner 上运行"。

除最薄的事件触发器与 GitHub 平台要求的桥接检查之外，所有重型执行（CI、测试、构建、AI Review、Release、Deploy 与定时任务）都在 Action Worker 中运行。

这条规则适用于公开仓库与私有仓库。仓库可见性只能影响访问方式与 GitHub 平台功能，绝不能产生第二套执行架构。

## 2. 统一执行链

```text
仓库事件
  ↓
Execution Request（执行请求）
  ↓
校验源与权限
  ↓
解析 Execution Manifest（执行清单）
  ↓
Plan（计划）
  ↓
授予能力
  ↓
解析 Runner
  ↓
在 Action Worker 中执行
  ↓
Evidence / Artifact / Provenance（证据 / 产物 / 来源证明）
  ↓
Gate / Publish / Deploy / Status（门禁 / 发布 / 部署 / 状态）
```

业务仓库不得用它自己的重型工作流绕过这条执行链。

## 3. 业务仓库负责的内容

业务仓库保留：

- 产品源码；
- 无法从仓库外部运行的项目测试（见 [TEST_PACKS.md](TEST_PACKS.md)）；
- 项目级的构建 / 打包 / 部署脚本；
- 项目运行所需的配置模板；
- 执行清单；
- 最薄的分发工作流；
- GitHub 平台要求目标仓库自行创建的极薄检查 / 状态桥接。

业务仓库可以声明执行需求，但不得声明中央凭据，也不得为自己授予权限。AI Review 只提供发现与建议；它不属于能力授予、CI 门禁或合并门禁。

## 4. Action Worker 负责的内容

Action Worker 负责：

- 校验源与提交身份；
- 确定性的 Security Gate，包括对新增密钥、敏感文件和危险工作流模式的检查；
- 仓库能力校验；
- 执行请求与清单校验；
- CI / 测试 / 构建 / AI Review / Release / Deploy / 任务的编排；
- Runner 选择；
- 注入中央密钥与令牌；
- 信任域隔离；
- 产物与 provenance；
- 门禁；
- 状态写回；
- 发布与部署权限；
- Main Write Guard 与 main 的可信来源；
- 失败、超时、取消与重试策略。

Action Worker 不保存项目的产品逻辑，也绝不按仓库、项目或产品名称选择执行实现。

## 5. 执行请求

调用方只提交不可变的任务身份与执行意图。长期的最小语义为：

```text
schema_version
request_id
repository
source_sha
operation
```

其中：

- `repository` 必须被中央 Repository Policy 允许；
- `source_sha` 必须是不可变的提交 SHA；
- `operation` 使用通用的操作类型，例如 `ci`、`review`、`build`、`release`、`deploy` 或 `task`；
- 调用方不得提交门禁结论、密钥、令牌、实际的 Runner 名称或中央权限结论。

某个操作可以在其机器合同中增加所需的字段，但不得突破这些边界。

## 6. 执行清单

执行清单始终位于业务仓库的 `.github/execution-manifest.json`，描述项目自身的执行需求，例如：

```text
operation
runner_profile
command
matrix
artifacts
timeout
capability_requests
```

`command` 是参数数组，而不是拼接的 shell 字符串。通用执行器只替换以下受控的运行时令牌：

```text
{target_root}
{control_root}
{temp_root}
{matrix.<key>}
```

`control_root` 是可信执行声明与脚本的检出目录；`target_root` 是待验证 SHA 的源码目录。对于 PR，清单与项目脚本从可信的 base / 默认分支读取；PR head 带来的新清单永远不会被直接执行。

清单可以描述：

- 所需的执行能力，例如 Linux / Windows / macOS / ARM；
- 调用哪个项目脚本；
- 需要哪些项目产物；
- 需要哪些通用能力。

清单不得描述：

- GitHub 令牌的名称或值；
- Cloudflare、SSH、生产或其他密钥；
- 中央管理令牌；
- 具体的 self-hosted Runner 名称；
- 具体的 Runner 标签组合；
- 对任何目标仓库的写权限；
- 绕过门禁的开关。

清单是能力请求，而不是能力授予。

## 7. 能力授予

Action Worker 根据以下事实构建授予：

```text
Repository Policy
+ operation（操作）
+ immutable source（不可变源码）
+ trust domain（信任域）
+ environment policy（环境策略）
+ requested capabilities（请求的能力）
```

业务仓库只能请求能力，不能自行授予能力。

例如：

```text
release.publish
deployment.production
source.private-read
artifact.write
```

某项能力是否被授予、映射到哪些密钥、以及是否只能在可信的 Runner 上运行，均由 Action Worker 决定。

## 8. 与仓库无关的规则

通用的 Action Worker 控制逻辑绝不能包含：

```text
if repository == ...
if project == ...
if product == ...
```

通过等价的项目映射表把项目专属的执行配方移入中央仓库，同样是禁止的。

项目级的命令与脚本留在项目仓库中；Action Worker 只读取标准清单，并通过通用执行器执行。

接入一个普通的新仓库，不得要求修改 Action Worker 的核心代码。

## 9. 公开仓库与私有仓库

公开仓库与私有仓库使用相同的执行合同。

长期目标是中央执行入口：由 GitHub App、webhook 或其他可信事件源直接接收事件，并在 Action Worker 中创建执行请求。业务仓库 GitHub Actions 的可用性、分钟数或 Runner 状态，绝不能成为中央治理与执行的前提。

业务仓库中现有的最薄分发工作流只是迁移路径。它可以暂时触发 Action Worker，但不得继续运行完整的 CI、构建、审查、发布或部署，也不得成为长期的安全前提。

目标链路：

```text
GitHub 仓库事件
→ 可信的中央入口
→ Action Worker Execution Request
→ 中央治理 / 执行
```

因此，当一个私有仓库的 Actions 分钟数耗尽时，PR Governance、CI、Release 与 Deploy 在长期架构中都不应停止。

## 10. main 来源要求

任何面向正式环境或正式分发的操作，都必须校验其源 SHA 的 Main Write Guard。

至少包括：

- `release`；
- `deploy`；
- 发布（publication）；
- 生产 / 特权执行。

源 SHA 位于 `main` 上不能替代来源证明。只有与该 SHA 精确绑定的 `Main Write Guard = success`，才能授予相应的能力。

AI Review 不属于这条校验链。AI Review 在确定性 PR 门禁结论之后运行，不能改变 Main Write Guard。

## 11. 迁移规则

当前实现可以保留迁移期的旧入口，但须满足：

1. 新能力不得进一步在业务仓库中增加重型执行；
2. 新仓库默认使用中央执行；
3. 旧的业务仓库工作流只能缩减，不得新增重型步骤；
4. Action Worker 中现有的项目专属执行映射，应逐步迁移到通用清单与通用执行器；
5. 文档绝不能把迁移期的实现描述为长期架构。

最终验收标准：

> 新增一个仓库、一个项目或一种 Runner 后端，都不需要修改 Action Worker 的内核。
