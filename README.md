<div align="center">

# Action Worker

**Fongap Labs 的中央 GitHub 自动化控制平面**

任务分发 · PR 治理 · AI 审查 · 发布治理 · 部署治理

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-34-2A5588?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-118-4B4F8F?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-570-2E6B73?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-9-8C6D3F?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&labelColor=1B2A41&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

[快速开始](#快速开始) · [维护者参考](#维护者参考)  · [安全策略](SECURITY.md)

</div>

> 新手请从 **这是什么** 读到 **快速开始**；维护者可直接跳到 [维护者参考](#维护者参考)。

## 这是什么

Action Worker 是 Fongap Labs 的**中央质检站**，为所有受管仓库（接入统一治理的业务仓库）服务。仓库只声明"要检查什么"，质检站自行拉取代码、运行检查、留下证据，最后由**门禁**（Gate，决定放行或阻断的检查）给出结论。

| 能力 | 解决的问题 |
|---|---|
| **PR 治理** | PR 能否合并由确定性门禁决定，AI 只提供参考 |
| **任务分发** | 把任务安全地交给中央执行，业务仓库不接触中央密钥 |
| **AI 审查** | 门禁通过后给出建议，不能改写门禁结论 |
| **发布治理** | 统一版本号、产物校验与回滚 |
| **部署治理** | 只有可信的 `main` 提交才能进入部署 |

## 一个例子

一个 PR 从提交到结论，经过的路径如下：

```mermaid
flowchart LR
    A["业务仓库<br/>PR 提交或更新"] --> B["控制域<br/>重新读取 SHA、标题与 diff"]
    B --> C["沙箱<br/>构建与测试"]
    C --> D["CI Evidence<br/>执行证据"]
    D --> E{"门禁 Gate<br/>证据是否通过？"}
    E -- "通过" --> F["PR Governance: success<br/>允许合并"]
    E -- "阻断" --> G["PR Governance: failure<br/>阻断合并"]
    F -.-> H["AI 审查<br/>门禁通过后，仅供参考"]
    classDef brand fill:#2A5588,stroke:#1B2A41,color:#FFFFFF
    classDef soft fill:#E8EEF6,stroke:#2A5588,color:#1B2A41
    classDef warm fill:#F4EDE0,stroke:#8C6D3F,color:#3B2E1A
    class F brand
    class A,B,C,D,E,H soft
    class G warm
```

门禁阻断时，合并被拦下；门禁通过后，AI 审查才会异步给出参考意见。

## 快速开始

### 接入一个业务仓库

接入分三步。完成后，每个 PR 打开或推送新提交时，都会出现 `PR Governance` 状态检查。

| 步骤 | 位置 | 操作 |
|---|---|---|
| 1 | 业务仓库 | 新建 `.github/workflows/dispatch-pr-governance.yml`，内容与[标准模板](templates/pr-dispatcher/dispatch-pr-governance.yml)逐字节一致 |
| 2 | 业务仓库的 Secrets | 配置 `AW_DISPATCH_TOKEN`，它只允许向 `action-worker` 发送分发事件 |
| 3 | Action Worker 的仓库变量 | 在 `AW_REPOSITORY_POLICY` 中登记仓库及其能力 |

第 3 步的示例：

```json
{
  "fongap-labs/example": ["pr", "task"]
}
```

| 能力 | 授权内容 |
|---|---|
| `pr` | PR 治理 |
| `task` | 任务分发 |
| `release-source` | 作为发布构建的源码 |
| `release-target` | 作为发布的目标 |
| `deploy` | 解析部署清单 `.github/deploy.json` |

### 常见问题

| 现象 | 排查 |
|---|---|
| PR 显示 `PR governance dispatch failed` | 打开该 PR 的 Actions 日志；若提示 `AW_DISPATCH_TOKEN is not configured.`，说明第 2 步未完成 |
| 没有任何 `PR Governance` 状态 | 确认第 1、3 步已完成，且仓库在 `AW_REPOSITORY_POLICY` 中拥有 `pr` 能力 |

## 进阶：Action Worker 如何工作

```mermaid
flowchart TB
    subgraph CTRL["控制域 Control"]
        direction LR
        POL["合同与策略<br/>contracts · policies"] --> PLAN["计划 Plan"]
        PLAN --> GATE{"门禁 Gate"}
    end
    subgraph SBX["沙箱 Sandbox"]
        RUN["检出 · 构建 · 测试<br/>不接触中央密钥"]
    end
    PLAN -- "任务清单" --> RUN
    RUN -- "CI Evidence" --> GATE
    classDef brand fill:#2A5588,stroke:#1B2A41,color:#FFFFFF
    classDef soft fill:#E8EEF6,stroke:#2A5588,color:#1B2A41
    classDef warm fill:#F4EDE0,stroke:#8C6D3F,color:#3B2E1A
    class POL,PLAN,GATE soft
    class RUN warm
```

| 术语 | 含义 |
|---|---|
| 分发（Dispatch） | 业务仓库发给质检站的"请处理"通知，只含仓库、PR 编号等标识，不含密钥 |
| 控制域（Control） | 可使用中央密钥，只读取证据并做决定，从不执行 PR 代码 |
| 沙箱（Sandbox） | 执行构建与测试，绝不接收中央密钥或部署凭据 |
| 计划（Plan） | 根据改动范围，决定需要运行哪些检查 |
| CI Evidence | 沙箱产生的执行记录，门禁只认可可验证的证据 |
| 门禁（Gate） | 唯一的合并许可：`validate-merge` 成功才放行 |
| 来源证明（provenance） | 记录产物由哪个不可变源码构建，供发布与部署核验 |

> 计划可以动态变化，权限边界与门禁必须保持固定。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `.github/workflows/` | GitHub 入口，编排分发、门禁、发布与部署 |
| `contracts/` | 输入输出的机器合同 |
| `policies/` | 确定性治理策略 |
| `rules/` | AI 审查规则 |
| `skills/` | 可复用的 Agent 执行技能 |
| `scripts/` | 共用执行脚本 |
| `tests/` | 治理与合同回归测试 |
| `templates/` | 业务仓库的标准触发器模板 |
| `docs/` | 面向人与 Agent 的治理文档 |

项目专属配置不属于 Action Worker，留在业务仓库中。

## 维护者参考

### 本地检查

需要 Node.js 24 及以上。提交前建议在本地运行：

| 命令 | 作用 |
|---|---|
| `npm ci` | 按锁文件安装依赖 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | Biome 代码与格式检查 |
| `npm test` | 治理与合同测试 |
| `npm run check` | 依次执行以上三项检查 |

### 发布与部署

```mermaid
flowchart LR
    SRC["源仓库不可变 SHA"] --> MAN["release.manifest.json<br/>源仓库自有清单"]
    MAN --> BUILD["中央构建与打包"]
    BUILD --> PROV["产物 + provenance<br/>来源证明"]
    PROV --> GOV["Release Governance<br/>校验并发布"]
    GOV --> CHECK["重新下载校验"]
    CHECK -- "失败" --> ROLL["回滚 release 与标签"]
    classDef brand fill:#2A5588,stroke:#1B2A41,color:#FFFFFF
    classDef soft fill:#E8EEF6,stroke:#2A5588,color:#1B2A41
    classDef warm fill:#F4EDE0,stroke:#8C6D3F,color:#3B2E1A
    class SRC,MAN,BUILD,PROV,CHECK soft
    class GOV brand
    class ROLL warm
```

- 版本号只来自发布时手动输入的值，标签格式为 `<release-key>-v<semver>`。
- 部署由源仓库的 `.github/deploy.json` 声明，在可信的 `main` 写入后自动执行，详见 [架构文档](docs/ARCHITECTURE.md) 第 13 节。

### 文档

| 想了解 | 阅读 |
|---|---|
| 文档总索引 | [docs/README.md](docs/README.md) |
| 共用治理与权威顺序 | [docs/SHARED_GOVERNANCE.md](docs/SHARED_GOVERNANCE.md) |
| 架构与当前实现 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 受管仓库接入规范 | [docs/INTEGRATION_GUIDE.md](docs/INTEGRATION_GUIDE.md) |
| 开发与验证流程 | [docs/DEVELOPMENT_GUIDE.md](docs/DEVELOPMENT_GUIDE.md) |
| 变更分类与 CHANGELOG | [docs/CHANGELOG_CONVENTIONS.md](docs/CHANGELOG_CONVENTIONS.md) |
| Agent 入口 | [CLAUDE.md](CLAUDE.md)、[skills/README.md](skills/README.md) |

## 参与贡献

- 面向人的文档用中文；工程 diff、PR 标题与 CHANGELOG 用英文。
- PR 标题格式为 `type(scope): summary`，`type` 取值见 [CHANGELOG 约定](docs/CHANGELOG_CONVENTIONS.md)。
- `feat`、`fix`、`perf`、`revert` 与破坏性变更必须更新 `CHANGELOG.md`。
- 治理变更必须同时更新合同、策略与回归测试；仅有文档不构成约束。
- 不按仓库名分支，不新增 `projects/`、`adapters/`、`profiles/` 目录。
- 提交信息只署名提交者，不含任何 AI Agent 或工具署名。

## 安全

PR 代码始终视为不可信输入。请通过 **Security → Advisories → Report a vulnerability** 私密报告问题，详见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
