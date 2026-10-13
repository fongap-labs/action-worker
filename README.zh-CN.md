<div align="center">

# Action Worker

[English](README.md) · **简体中文**

**GitHub 自动化编排与治理中枢**

任务调度 · AI Agent · PR 治理 · 发布治理 · 部署治理

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-32-1A61FE?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-118-0527FC?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-553-212183?style=flat-square)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-9-08872B?style=flat-square)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

<sub>统计口径：Task Dispatch = Handle Task Dispatch 成功次数 · AI Review = AI Review 成功执行次数 · PR Governance = Handle PR Dispatch 成功次数 · Release Governance = Handle Release Dispatch 成功次数</sub>

</div>

---

## Action Worker 是什么

Action Worker 是 Fongap Labs 多个 GitHub 仓库的中央自动化枢纽。它决定一项变更能否合并、发布或部署，并统一运行共用任务（测试、构建、AI 审查），使业务仓库无需各自维护流水线。

可以把它理解为“裁判加工坊”：

- 业务仓库**声明**希望发生什么；
- Action Worker **核实** GitHub 上的事实，**判定**是否允许，并**执行**；
- Runner 只是完成工作的计算资源，本身不具备任何权限。

## 能力

| 能力 | 用途 |
|---|---|
| **PR Governance** | 检查每个 Pull Request，收集 CI Evidence，写入 `PR Governance` 状态与 `validate-merge` 合并门禁 |
| **Task Dispatch** | 在固定且不可变的 commit 上运行可信的项目任务 |
| **Release Governance** | 集中构建产物、校验、发布，失败时回滚 |
| **Deploy Governance** | 在通过来源校验后，经源仓库自有脚本部署某个 commit |
| **Main Write Guard** | 证明每个 `main` commit 都来自通过门禁并已合并的 PR |
| **AI Review** | 可选，仅提供建议，从不改变门禁结果 |
| **Agent Skills** | AI Agent 处理这些仓库时遵循的共用执行规则 |

## Pull Request 的治理流程

```text
受管仓库中的 PR 被打开或更新
  ↓  轻量 dispatch（业务仓库不包含治理逻辑）
Action Worker 从 GitHub 重新读取 PR 的 base、head、标题与 diff
  ↓
安全门禁 → CI Evidence（测试在沙箱中运行）→ 确定性策略
  ↓
validate-merge 状态（唯一的合并权限）
  ↓  仅在门禁通过后
可选 AI 审查 → 仅供参考的摘要
```

Action Worker 从不信任调用方提供的 base SHA、head SHA、门禁结果或模型。这些值都从 GitHub 读取。

## 快速开始

### 接入一个仓库

1. 维护者把仓库及其能力写入仓库变量 `AW_REPOSITORY_POLICY`。
2. 将 [`templates/pr-dispatcher/dispatch-pr-governance.yml`](templates/pr-dispatcher/dispatch-pr-governance.yml) 原样复制到仓库中。它是已批准的模板，必须与原文件逐字节一致。
3. 添加 `.github/execution-manifest.json`，描述需要执行的内容，并声明 `runner_profile`，而不是具体的 runner。

完整步骤和所需密钥见 [接入指南](docs/INTEGRATION_GUIDE.md)（英文）。

### 开发 Action Worker

```bash
npm ci
npm run check   # 类型检查、lint 与测试套件
```

需要 Node.js 24 或更高版本，已在 `package.json` 中声明。

## 设计原则

- **确定性规则做决定，AI 只提供建议。** 策略、合同与 CI Evidence 是合并权限的依据。
- **调用方指定目标，Action Worker 核实事实。**
- **不含仓库专属逻辑。** Action Worker 从不按仓库名或项目名分支。
- **密钥不进入运行不可信代码的环境。** 运行 Pull Request 代码的沙箱不接收中央凭据。

## 文档

- [文档索引](docs/README.zh-CN.md)：全部治理、架构与指南文档
- [共用治理](docs/SHARED_GOVERNANCE.md)：权威顺序与共用规则
- [架构](docs/ARCHITECTURE.md) 与 [架构治理](docs/ARCHITECTURE_GOVERNANCE.md)
- [接入指南](docs/INTEGRATION_GUIDE.md)：接入受管仓库
- [开发指南](docs/DEVELOPMENT_GUIDE.md)：验证与 PR 流程
- [Agent 指南](CLAUDE.md) 与 [Agent Skills](skills/README.md)
- [安全策略](SECURITY.zh-CN.md)

## 许可证

[MIT](LICENSE)
