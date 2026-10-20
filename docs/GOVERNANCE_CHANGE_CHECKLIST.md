# 修改共用治理清单

**每次修改共用治理（策略、命名、变更分类、PR 门禁、执行合同、Runner 策略、Main Write Guard、语言规则等）必须同步完成以下所有项。** 提交 PR 前自检，Reviewer 必须逐项确认。

---

## 1. 策略文件（`policies/`）

- [ ] `repository.json` — 仓库默认设置（Issues/Projects/Wiki/Discussions、合并方式、自动清理）
- [ ] `rulesets.json` — `Protect Main Branch` / `Protect Legacy Branches` 规则集定义
- [ ] `attribution.json` — AI 署名卫生策略（blocked_terms, identity_only_terms, blocked_trailer_keys, blocked_line_prefixes）
- [ ] `release.json` — 变更类型、必需 CHANGELOG 类型、CHANGELOG 文件路径、影响模式
- [ ] `security.json` — 密钥扫描规则、允许列表、AI Review 引擎锁定哈希
- [ ] `deploy-secrets.json` — 部署密钥上限、别名映射
- [ ] `deploy-environments.json` — 可部署环境白名单
- [ ] `task-secrets.json` — 任务密钥上限、别名映射
- [ ] `execution.json` — 执行合同默认值（runner profile 映射、超时、能力边界）
- [ ] `repository-policy.json` — `AW_REPOSITORY_POLICY` 变量对应的仓库能力矩阵

> 修改任一策略文件后，必须同步更新对应的**合同测试**（见下）。

---

## 2. 合同测试（`tests/`）

- [ ] `governance-contract.test.ts` — 验证 main ruleset 必含 `validate-merge` 且 `strict_required_status_checks_policy: true`
- [ ] `workflow-classes.test.ts` — 验证工作流分类、命名、权限、超时、concurrency
- [ ] `workflow-naming.test.ts` — 验证工作流文件名三段限制、显示名映射
- [ ] `documentation-language.test.ts` — 验证机器文档纯英文、人类文档含中文、无 `*.zh-CN.md`
- [ ] `validate-change-record.test.ts` — 验证 PR 标题格式、CHANGELOG 条目、AI 署名卫生
- [ ] `validate-engineering-language.test.ts` — 验证工程 diff 纯英文、例外路径豁免
- [ ] `validate-changelog-format.test.ts` — 验证 ASCII-only、无 markdown、≤120 字符、无尾句号、类型小写
- [ ] `naming-rules.test.ts` / `validate-source-naming.py` — 验证外部名称、缩写、配置类型词

---

## 3. 核心治理文档（`docs/`）

- [ ] `01_SHARED_GOVERNANCE.md` — 权威边界、共用规则、语言分层、Agent 入口、机器执行、平台能力
- [ ] `02_REPOSITORY_GOVERNANCE.md` — Repository Policy、应用方式、合并权限、原生强制、Main Write Guard 引用
- [ ] `03_NAMING_CONVENTIONS.md` — 命名优先级、外部边界名称、本地标识符、缩写、配置类型词、工程语言、文件/术语/动词、Action Worker 专属
- [ ] `04_CHANGELOG_CONVENTIONS.md` — 语言、唯一变更分类、变更属性、PR 标题、CHANGELOG 文件、条目格式、必写规则、Agent 职责、禁止事项、Release
- [ ] `05_INTEGRATION_GUIDE.md` — 接入目标流程、业务仓库保留内容、执行请求/清单、CI 与 PR、安全扫描、依赖修复、Runner、中央配置、Main Write Guard 桥接、任务、Release、Deploy、新仓库不应做的事、平台边界、迁移期
- [ ] `06_RELEASE_DEPLOY_GUIDE.md` — Release/Deploy 手动操作、启动前检查/常见失败、多产品发布/部署、定时部署、跟随型产品
- [ ] `07_MAIN_WRITE_GUARD.md` — 规则、触发时机、证明逻辑、失败后果、业务仓库桥接、故障排查
- [ ] `08-runner-policy.md` — Runner Profile 定义、解析器逻辑、backend 选择、self-hosted 边界、特权 Runner
- [ ] `08-architecture-governance.md` — 架构治理规则（如有变更）
- [ ] `GOVERNANCE_CHANGE_CHECKLIST.md` — 本清单（如流程本身变更）
- [ ] `TERMINOLOGY.md` — 术语表（如新增/修改术语）

> 修改策略文件时，对应章节必须同步更新术语、示例、错误码表。

---

## 4. 机器执行脚本（`scripts/`）

- [ ] `apply-repository-settings.ts` — 读取 policies/*.json，幂等应用 Repository Settings 与 rulesets
- [ ] `validate-change-record.ts` — PR 标题、CHANGELOG、AI 署名、变更分类
- [ ] `validate-engineering-language.ts` — 工程 diff 英文检查
- [ ] `validate-changelog-format.ts` — CHANGELOG 格式校验（ASCII、无 markdown、长度、句号、类型、属性）
- [ ] `validate-security.ts` — Security Gate（密钥扫描、AI Review 引擎哈希、依赖修复边界）
- [ ] `validate-naming-rules.ts` / `validate-source-naming.py` — 命名规范校验
- [ ] `main-write-guard.ts` — Main Write Guard 审计逻辑
- [ ] `dispatch-central-ci.ts` / `wait-ci-evidence.ts` / `validate-ci-evidence.ts` — CI Evidence 流程
- [ ] `resolve-pr-facts.ts` / `resolve-pr-plan.ts` / `detect-pr-context.ts` — PR 事实与计划
- [ ] `set-pr-status.ts` / `check-status-owner.ts` — 状态发布与所有权
- [ ] `pr-trust.ts` — PR 信任度（未受信作者需维护者批准）
- [ ] `publish-pr-review.ts` / `dispatch-pr-review.ts` — AI Review 分发
- [ ] `dispatch-security-scan.ts` — 安全扫描分发
- [ ] `dispatch-central-deploy.ts` / `dispatch-scheduled-deploys.ts` — 部署分发
- [ ] `dispatch-scheduled-tasks.ts` / `intake-task-sources.ts` — 任务分发
- [ ] `sync-tool-release.ts` — 工具发布同步

> 修改策略/合同时，对应脚本的输入输出 Schema、错误码、默认值必须同步。

---

## 5. 预览与验证

- [ ] 本地运行预览：
  ```bash
  node scripts/apply-repository-settings.ts <owner/name> true
  ```
  仅打印将要应用的设置与 rulesets，不调用 GitHub。
- [ ] 跑全量测试：
  ```bash
  npm test
  ```
  必须全绿。

---

## 6. PR 规范

- **标题**：`chore(governance): <简述>` 或 `feat(governance): <简述>` / `fix(governance): <简述>`
- **CHANGELOG**：必须在 `CHANGELOG.md` 的 `[Unreleased]` 下添加条目，属性包含 `[migration]`（如涉及策略/合同变更）或 `[breaking]`（如移除字段/改变默认行为）
- **描述**：列出修改的策略文件、测试、文档、脚本；说明迁移路径（如有）

---

## 7. 合并后动作

- [ ] 合并后，`apply-repository-settings.yml` 会在下一次 push/main 或定时运行时自动应用到所有受管仓库
- [ ] 观察 Actions：`Apply Repository Settings`、`Main Write Guard`、`Intake` 运行无报错
- [ ] 如有破坏性变更，需在相关业务仓库协调发布/部署/任务的手动验证

---

## 附：文件名映射表（重构前→后）

| 旧文件 | 新文件 |
|--------|--------|
| `01_SHARED_GOVERNANCE.md` | `01_SHARED_GOVERNANCE.md` |
| `02_REPOSITORY_GOVERNANCE.md` | `02_REPOSITORY_GOVERNANCE.md` |
| `03_NAMING_CONVENTIONS.md` | `03_NAMING_CONVENTIONS.md` |
| `04_CHANGELOG_CONVENTIONS.md` | `04_CHANGELOG_CONVENTIONS.md` |
| `05_INTEGRATION_GUIDE.md` | `05_INTEGRATION_GUIDE.md` + `06_RELEASE_DEPLOY_GUIDE.md` |
| `07_MAIN_WRITE_GUARD.md` | `07_MAIN_WRITE_GUARD.md` |
| `08-runner-policy.md` | `08-runner-policy.md` |
| `10-architecture-governance.md` | `10-architecture-governance.md` |
| `09-execution-contract.md` | `09-execution-contract.md` |
| （新增） | `00_GOVERNANCE_OVERVIEW.md` |
| （新增） | `GOVERNANCE_CHANGE_CHECKLIST.md` |
| （新增） | `TERMINOLOGY.md` |

> 旧文件保留一周作为重定向，首行标注 `> **已移至 [新文档](新路径)**`，一周后删除。