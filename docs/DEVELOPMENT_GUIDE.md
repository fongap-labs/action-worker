# 开发指南

本文件定义 Action Worker 与受管业务仓库共用的开发流程。机器边界由合同、策略、规则与治理文档确定。

## 1. 开始之前

先做以下判断：

1. 这是项目实现，还是通用的治理 / 执行能力；
2. 是否已有可复用的合同、策略、执行器或 skill；
3. 变更是否涉及信任、密钥、Runner、门禁、发布或部署边界；
4. 合同测试与文档是否需要同步修改。

原则：

> 项目实现留在业务仓库；治理、授权与重型执行进入 Action Worker。

公开仓库与私有仓库遵循相同的规则。

## 2. Action Worker 负责的内容

Action Worker 负责：

- PR 治理、CI Evidence 与 AI Review；
- CI / 测试 / 构建执行；
- 任务与定时执行；
- Runner 解析与门禁；
- Source Policy；
- Release 的构建、治理与发布；
- Deploy 的治理与执行；
- 产物与 provenance（来源证明）；
- 通用的状态写回与输入输出合同。

## 3. 业务仓库负责的内容

业务仓库保留：

- 产品代码；
- 无法从仓库外部运行的项目测试（见 [TEST_PACKS.md](TEST_PACKS.md) 第 6 节）；
- 构建 / 打包 / 部署脚本；
- 项目架构与协议；
- 执行清单；
- 平台专属的工具链声明；
- 最薄的分发入口；
- GitHub 平台确实需要时的一个极薄的检查桥接。

业务仓库不得保留第二套中央治理，也不得为了自身方便而长期运行重型的 CI / 构建 / 审查 / 发布 / 部署。

## 4. 开发流程

```text
检查
→ 定义合同
→ 实现
→ 测试
→ PR
→ Security Gate
→ Central CI
→ Governance / validate-merge
├→ 合并
└→ AI Review（门禁之后，仅供参考）

合并
→ Main Write Guard
→ 可信的 main SHA
```

当边界发生变化时，先修改合同、策略或回归测试，再修改实现。

## 5. CI

能够从仓库外部运行的测试，保存在 Action Worker 的测试包中（[TEST_PACKS.md](TEST_PACKS.md)）；其余测试保留在业务仓库中。所有测试默认都在 Action Worker 的沙箱中运行。

```text
仓库事件
→ 薄分发
→ Action Worker
→ 检出不可变源码
→ 项目测试 / 构建
→ CI Evidence
```

如果 GitHub 平台要求目标仓库自行创建必需检查，可以保留一个极薄的 `validate-merge` 桥接。该桥接不运行任何产品测试，只负责连接中央的 `CI Evidence` 与 `PR Governance`。

## 6. Runner

项目代码不得绑定具体的 Runner 基础设施。项目只声明 `runner_profile`；Action Worker 的 Runner 策略负责解析为实际的 GitHub 托管或 self-hosted 后端。

新增 self-hosted Runner 不得要求修改业务仓库。详细规则见 [08-runner-policy.md](08-runner-policy.md)。

## 7. 工作流变更

工作流变更至少检查以下内容：

- 权限是否最小化；
- 密钥是否可能到达不可信的执行域；
- 触发器是否可能被 fork 或 PR 输入滥用；
- 并发是否正确；
- 源 SHA 是否不可变；
- Runner 是否由中央策略选择；
- 产物与证据是否绑定到源 SHA。

此外还要通过确定性的 Security Gate、actionlint、合同测试，以及在需要时的 ShellCheck。

工作流文件名遵循 [03-naming-conventions.md](03-naming-conventions.md) §2的规则；`tests/workflow-naming.test.ts` 会对其进行检查。

Security Gate 独立于 AI Review，至少阻止以下内容：新增的高置信度凭据、敏感密钥文件、`toJSON(secrets)`、`pull_request_target`、`permissions: write-all`，以及未固定到提交 SHA 的外部 action。

控制逻辑优先使用 TypeScript 编写。Shell 只能作为简短的 Runner 胶水代码，或明确的外部引导边界。

## 8. AI 与门禁

AI 负责审查、建议与发现问题；它既不决定权限边界，也不决定合并门禁。AI Review 在确定性 PR 门禁结论之后运行，无论严重程度如何，每个 AI 发现都只是仅供参考的证据。AI Review 超时、模型不可用或审查引擎故障，既不能改变门禁，也不能延迟门禁的结论。

门禁只信任确定性策略、Security Gate、CI Evidence、PR Policy、Release / Deploy Policy、当前的 GitHub 事实以及执行 provenance。

Agent 不得通过重新运行、更换模型、更换 Runner 或调整任何审查参数来改变确定性门禁。

## 9. Main Write Guard

每个进入正式 Release 或 Deploy 的源 SHA，都必须先通过 Main Write Guard。名为 `main` 的分支本身不构成可信来源的证明。

直接 push、未知写入，或无法关联到已通过门禁的已合并 PR 的 SHA，都失败即关闭。

## 10. Release / Deploy

业务仓库负责项目脚本；Action Worker 负责中央执行、凭据与治理。

```text
Release：不可变源码 → 中央构建 / 打包 → 产物 + provenance → Release Governance → 发布 / 验证 / 回滚
Deploy： 不可变源码 → 中央源门禁 → 项目部署脚本 → Runner 解析 → 受控部署 → 健康检查 / 回滚
```

## 11. 完成定义

在结束一项任务之前，确认：

- 没有新增按仓库名或项目名划分的分支；
- 没有在业务仓库中新增重型执行；
- 没有把 Runner 基础设施写入项目合同；
- 不存在第二个密钥、门禁或发布权威；
- 合同测试覆盖了新边界；
- 文档区分了"当前实现"与"目标边界"；
- 旧的入口已被删除，或已明确列入迁移清单；
- 新增或修改的文档，没有项目背景的人也能读懂（见 [01-shared-governance.md](01-shared-governance.md) §2）。
