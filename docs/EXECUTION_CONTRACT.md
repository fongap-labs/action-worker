# Execution Contract

本文档定义 Fongap Labs 受管仓库与 Action Worker 之间的统一执行边界。它适用于公开仓库和私有仓库，不因仓库可见性而改变。

## 1. 核心原则

```text
Business repository
= source + tests + project scripts + execution intent

Action Worker
= governance + authorization + planning + execution + evidence + provenance

Runner
= disposable compute backend
```

业务仓负责描述“需要做什么”，Action Worker 决定“是否允许、如何执行、在哪类 Runner 上执行”。

除最薄事件触发器和 GitHub 平台必须保留的桥接检查外，CI、test、build、AI Review、release、deploy、scheduled task 等重执行应统一运行在 Action Worker。

这一规则同时适用于 public 与 private repository。仓库可见性只能影响访问方式和 GitHub 平台能力，不得产生第二套执行架构。

## 2. 统一执行链

```text
Repository event
  ↓
Execution Request
  ↓
Validate source and authority
  ↓
Resolve Execution Manifest
  ↓
Plan
  ↓
Grant capabilities
  ↓
Resolve Runner
  ↓
Execute in Action Worker
  ↓
Evidence / Artifact / Provenance
  ↓
Gate / Publish / Deploy / Status
```

业务仓不得通过自己的重型 workflow 绕过这条链。

## 3. Business repository owns

业务仓保留：

- 产品源码；
- 项目测试；
- 项目级 build / package / deploy 脚本；
- 项目运行所需配置模板；
- Execution Manifest；
- 最薄 dispatch workflow；
- GitHub 平台要求必须由目标仓自身创建的极轻 Check / status bridge。

业务仓可以声明执行需求，但不得声明中央凭据或授予自己权限。AI Review 只能提供 finding / suggestion，不属于 Capability Grant、CI Gate 或 Merge Gate。

## 4. Action Worker owns

Action Worker 统一负责：

- 来源与 Commit 身份验证；
- deterministic Security Gate，包括新增 Secret、敏感文件与危险 Workflow 模式检查；
- Repository capability 校验；
- Execution Request / Manifest 校验；
- CI / test / build / AI Review / release / deploy / task orchestration；
- Runner 选择；
- 中央 Secret 与 Token 注入；
- 信任域隔离；
- artifact 与 provenance；
- Gate；
- 状态回写；
- 发布与部署权限；
- 失败、超时、取消和重试策略。

Action Worker 不保存项目产品逻辑，也不得通过仓库名称、项目名称或产品名称选择执行实现。

## 5. Execution Request

调用方只提交不可变任务身份与意图。长期最小语义为：

```text
schema_version
request_id
repository
source_sha
operation
```

其中：

- `repository` 必须由中央 Repository Policy 允许；
- `source_sha` 必须是不可变 Commit SHA；
- `operation` 使用通用操作类型，例如 `ci`、`review`、`build`、`release`、`deploy`、`task`；
- 调用方不得提交 Gate 结论、Secret、Token、实际 Runner 名称或中央权限结论。

不同 operation 可以在机器合同中增加必要字段，但不得破坏以上边界。

## 6. Execution Manifest

Execution Manifest 描述项目自己的执行需求，例如：

```text
operation
runner_profile
commands
matrix
artifacts
timeout
capability_requests
```

Manifest 可以描述：

- 需要 Linux / Windows / macOS / ARM 等执行能力；
- 需要调用哪个项目脚本；
- 需要哪些项目 artifact；
- 需要哪些通用 capability。

Manifest 不得描述：

- GitHub Token 名称或值；
- Cloudflare、SSH、生产环境等 Secret；
- 中央管理 Token；
- 具体 self-hosted Runner 名称；
- 具体 Runner label 组合；
- 任意目标仓写权限；
- 绕过 Gate 的开关。

Manifest 是 Capability Request，不是 Capability Grant。

## 7. Capability grant

Action Worker 根据以下事实生成 Grant：

```text
Repository Policy
+ operation
+ immutable source
+ trust domain
+ environment policy
+ requested capabilities
```

业务仓只能申请 capability，不能自行授予。

例如：

```text
release.publish
deployment.production
source.private-read
artifact.write
```

是否获得、对应什么 Secret、是否只能运行在受信 Runner，由 Action Worker 决定。

## 8. Repository-agnostic rule

Action Worker 的通用控制逻辑禁止出现：

```text
if repository == ...
if project == ...
if product == ...
```

也禁止用等价的项目映射表把项目专属执行 recipe 搬到中央仓。

项目级命令和脚本应留在项目仓；Action Worker 只读取标准 Manifest 并通过通用 Executor 执行。

新增普通仓库时，正常接入不应要求修改 Action Worker 核心代码。

## 9. Public and private repositories

公开仓库和私有仓库使用同一 Execution Contract。

私有仓可以保留最薄 dispatch workflow 触发 Action Worker，但不得因此继续运行完整 CI、build、review、release 或 deploy。

如果未来由 GitHub App、Webhook 或其他可信事件源直接创建 Execution Request，可以进一步删除业务仓的 dispatch Runner；这属于入口优化，不改变统一执行边界。

## 10. Migration rule

当前实现允许存在迁移期旧入口，但必须满足：

1. 新增能力不得继续扩大业务仓重执行；
2. 新增仓库默认采用中央执行；
3. 旧业务仓 workflow 只允许继续缩小，不允许增加新的重步骤；
4. Action Worker 中现有项目专属执行映射应逐步迁移为通用 Manifest + Executor；
5. 文档不得把迁移期实现描述为长期架构。

最终验收标准：

> 新增仓库、新项目或新的 Runner 后端，不需要修改 Action Worker Kernel。
