# ORG-006 Ruleset 加固：Owner 决策简报

> 配合提案 ORG-006《加固 main 分支 ruleset》。本文档汇总第二、三阶段的关键决策点，供 owner 拍板。

---

## 背景

- **第一阶段已采纳**（PR #477）：四公开仓库启用严格状态检查（分支必须与 `main` 保持最新）。
- **私有仓库**：Free 套餐限制，无法配置 ruleset。补偿控制 = Main Write Guard（已覆盖 7 仓库，状态均 success）。
- **组织成员**：2 人（`fongap`、`fongxen`）+ 大量自动化 PR（Dependabot、指标、机器人）。

---

## 第二阶段：一人审批 + 绕过主体

### 选项

| 选项 | 内容 | 优点 | 风险 |
|------|------|------|------|
| **1A: 要求 1 人审批** | 每个 PR 需除作者外一人批准；Dependabot/自动化 PR 同理 | 安全性最高，符合最佳实践 | 两人组织中，一人离开即完全阻塞；无绕过主体则无退路 |
| **1B: 要求 1 人审批 + `fongap` 为绕过主体** | 同 1A，但 `fongap` 可绕过（仅 PR 模式） | 保留紧急路径 | 绕过主体削弱强制性；需严格限定模式 |
| **1C: 不采用** | 维持现状（0 审批） | 无阻塞 | 无人工审批屏障 |

### 建议

**采用 1B（要求 1 人审批 + `fongap` 为 PR 模式绕过主体）**，前提：
- 仅在有第二名常规评审者（`fongxen` 活跃）时启用
- 同一 PR 中同时添加绕过主体，避免自我阻塞
- 先在单仓库（如 `action-worker`）试运行一周

### 实施细节

```json
// policies/rulesets.json 片段
"required_approving_review_count": 1,
"bypass_actors": [
  { "actor_id": 26006683, "actor_type": "User", "bypass_mode": "pull_request" }
]
```

---

## 第三阶段：GitHub App 绑定 `validate-merge`

### 现状

- `validate-merge` 以提交状态发布（非 Check Run），无 `integration_id` 绑定
- 任何有写权限和令牌的人可伪造该状态

### 选项

| 选项 | 内容 | 优点 | 代价 |
|------|------|------|------|
| **4A: 引入 GitHub App** | 注册 App、存密钥、轮换、改发 Check Run、绑定 `integration_id` | 真正绑定身份，防伪造 | 基建成本：App 注册、Secret 管理、轮换流程 |
| **4B: 不引入** | 维持现状，依赖 Main Write Guard 兜底 | 零成本 | 理论上可被令牌持有者伪造 |

### 关联性

- AW-002（环境隔离）的 `admin-ops` 环境也需 App 身份
- AW-005/AW-007（检查脚本集中化）的中央 CI 同样受益

### 建议

**暂缓，仅在因其他原因引入 GitHub App 时同步实施**。当前风险可接受：Main Write Guard 对私有仓库实时审计，公开仓库受 ruleset 保护。

---

## Owner 决策清单

| 决策项 | 选项 | 建议 | Owner 拍板 |
|--------|------|------|------------|
| 第二阶段：是否启用 1 人审批 | 1A / 1B / 1C | 1B（含 `fongap` 绕过） | ☐ 是 ☐ 否 ☐ 修改 |
| 第二阶段：何时启用 | 立即 / 有第二评审者时 / 从不 | 有第二评审者时 | ☐ 是 ☐ 否 ☐ 修改 |
| 第三阶段：是否引入 GitHub App | 4A / 4B | 4B（暂缓） | ☐ 是 ☐ 否 ☐ 修改 |
| 私有仓库补偿控制 | 维持 Main Write Guard | 维持 | ☐ 确认 |

---

## 回滚方式

所有 ruleset 变更仅需还原 `policies/rulesets.json`，下一次 `apply-repository-settings.yml` 运行即恢复。建议先 `is_dry_run: true` 单仓库试验。

---

*生成时间：2026-10-20*