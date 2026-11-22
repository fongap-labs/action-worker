<div align="center">

# 中央自动化工作器

Fongap Labs 的中央 GitHub 自动化控制平面统一负责任务分发、PR 治理、AI 审查、发布治理与部署治理。

<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-163-2A5588?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-118-4B4F8F?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-2%2C238-2E6B73?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-93-8C6D3F?style=flat-square&labelColor=1B2A41)](https://github.com/fongap-labs/action-worker/releases) [![Status](https://img.shields.io/github/actions/workflow/status/fongap-labs/action-worker/validate-ci.yml?branch=main&style=flat-square&labelColor=1B2A41&label=Status)](https://github.com/fongap-labs/action-worker/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->

[快速开始](#快速开始) · [接入指南](docs/05_INTEGRATION_GUIDE.md) · [维护者参考](#维护者参考) · [安全策略](SECURITY.md)

</div>

## 作用

Action Worker 是 Fongap Labs 的 GitHub 中央控制平面，负责任务分发、PR 治理、中央 CI、AI 审查、发布与部署治理。业务仓库保留产品代码和专属规则；共用治理集中在本仓库。

| 职责 | 原则 |
|---|---|
| PR 与 CI | 以当前提交的可信 CI 证据和确定性门禁决定是否合并；AI 审查仅供参考 |
| 任务分发 | 控制域验证身份和权限；不可信代码仅在隔离环境执行 |
| 发布与部署 | 校验不可变源码、构建产物与来源证明，阻断未经验证的发布 |
| 仓库治理 | 合同、策略和规则集中定义；仓库按授权能力接入 |

## 快速开始

1. 阅读[接入指南](docs/05_INTEGRATION_GUIDE.md)，确认业务仓库已获授权。
2. 使用[标准通知模板](templates/bridge/notify-action-worker.yml)接入仓库。事件入口、身份和令牌权限以接入指南及现行策略为准，不从 README 复制凭据配置。
3. 在业务仓库创建 PR，并检查中央 CI、PR Governance 与合并门禁的实际状态；未完成验收不得视为放行。

需要扩展任务、发布或部署能力时，使用[执行合同](docs/EXECUTION_CONTRACT.md)及[发布部署指南](docs/06_RELEASE_DEPLOY_GUIDE.md)，不要复制中央工作流实现。

## 项目结构

| 路径 | 用途 |
|---|---|
| `.github/workflows/` | 入口与工作流编排 |
| `scripts/` | 执行器和校验逻辑 |
| `contracts/`、`policies/`、`rules/` | 机器合同、确定性策略、审查规则 |
| `tests/` | 控制平面测试与受管仓库测试包 |
| `skills/` | Agent 执行技能 |
| `templates/` | 受管仓库接入模板 |
| `docs/` | 治理、架构、运维文档 |

## 维护者参考

- [文档索引](docs/README.md) · [架构](docs/ARCHITECTURE.md) · [共用治理](docs/01_SHARED_GOVERNANCE.md)
- [主分支写入保护](docs/07_MAIN_WRITE_GUARD.md) · [安全策略](SECURITY.md) · [开发指南](docs/DEVELOPMENT_GUIDE.md)
- [Agent 入口](CLAUDE.md) · [技能索引](skills/README.md) · [更新日志](CHANGELOG.md)

代码变更采用 `feat`、`fix`、`chore` 分类；治理变更必须同时满足机器合同、策略与 CI 校验。单人维护不以额外人工审查代替 CI 门禁。

本地验证要求 Node.js 24+：

```sh
npm ci
npm run check
```

## 安全与许可

勿在公开 Issue 中披露安全问题，使用[私密安全报告](SECURITY.md)。许可证为 [MIT](LICENSE)。
