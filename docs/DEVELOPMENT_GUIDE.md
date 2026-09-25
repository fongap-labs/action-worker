# 开发指引

本文档定义 Action Worker 和受管业务仓共用的开发流程。机器边界以 contracts / policies / rules 和治理文档为准。

## 1. 开始前

先判断：

1. 这是项目实现还是通用治理 / 执行能力；
2. 是否已有可复用 Contract、Policy、Executor 或 Skill；
3. 是否改变 Trust、Secret、Runner、Gate、Release 或 Deploy 边界；
4. 是否需要同步合同测试和文档。

原则：

> 项目实现留在业务仓；治理、授权和重执行统一进入 Action Worker。

公开仓库与私有仓库遵守同一规则。

## 2. Action Worker owns

Action Worker 承载：PR Governance、CI / test / build execution、AI Review、CI Evidence、Task / scheduled execution、Runner Resolution、Gate、Source Policy、Release build / governance / publish、Deploy governance / execution、Artifact / provenance、通用状态回写和通用输入输出合同。

## 3. Business repository owns

业务仓保留：产品代码、项目测试、build / package / deploy 脚本、项目架构与协议、Execution Manifest、平台专属工具链声明、最薄 dispatch，以及 GitHub 平台确有需要时的极轻 Check bridge。

业务仓不得保留第二套中央治理，也不得为了方便自己运行长期重型 CI / build / review / release / deploy。

## 4. 开发流程

```text
Inspect
→ Define Contract
→ Implement
→ Test
→ PR
→ Central CI
→ optional AI Review
→ Governance
→ Merge
```

涉及边界变更时优先修改合同、Policy 或回归测试，再修改实现。

## 5. CI

项目测试代码属于业务仓，执行默认属于 Action Worker Sandbox。

```text
repository event
→ thin dispatch
→ Action Worker
→ checkout immutable source
→ project test / build
→ CI Evidence
```

如果 GitHub 平台要求目标仓创建 Required Check，可保留极轻 `validate-merge` bridge。该 bridge 不运行产品测试，只汇合中央 `CI Evidence` 与 `PR Governance`。

## 6. Runner

项目代码不得绑定具体 Runner 基础设施。项目只声明 `runner_profile`。实际 GitHub-hosted / self-hosted 后端由 Action Worker Runner Policy 解析。

新增 self-hosted Runner 不应要求修改业务仓。详细规则见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。

## 7. Workflow 修改

Workflow 变更至少检查：permissions 是否最小、Secret 是否进入不可信执行域、trigger 是否可被 fork / PR 输入滥用、concurrency 是否正确、source SHA 是否不可变、Runner 是否通过中央策略选择、artifact / evidence 是否绑定 source SHA，以及 actionlint / 合同测试 / ShellCheck。

控制逻辑优先 TypeScript。Shell 只作为短小 Runner glue 或明确的外部 bootstrap 边界。

## 8. AI 与 Gate

AI 负责审核、建议和问题发现，不决定权限边界，也不是合并门槛。

Gate 只相信 deterministic policy、Security Gate、CI Evidence、Release / Deploy Policy、GitHub 当前事实和 execution provenance。AI Review Result 可以作为人工判断和后续修复的 Evidence，但不得作为自动阻断条件。

AI Review 失败、超时、模型不可用或发现 high / critical 问题时，应保留可见结果或 unavailable 状态，但不得直接把确定性 Gate 改成失败。

Security Gate 必须独立于 AI，至少检查新增 Secret 材料、敏感文件和高风险 Workflow 泄密模式。

## 9. Release / Deploy

业务仓拥有项目脚本；Action Worker 拥有中央执行、凭据和治理。

```text
Release: immutable source → central build/package → artifact + provenance → Release Governance → publish / verify / rollback
Deploy:  immutable source → central source gate → project deploy script → Runner Resolver → controlled deploy → health verify / rollback
```

## 10. 完成标准

任务结束前确认：

- 没有新增仓库名 / 项目名分支；
- 没有新增业务仓重执行；
- 没有把 Runner 基础设施写进项目合同；
- 没有第二套 Secret / Gate / Release 权威；
- 合同测试覆盖新边界；
- 文档区分当前实现与目标边界；
- 旧入口已删除或明确进入迁移清单。
