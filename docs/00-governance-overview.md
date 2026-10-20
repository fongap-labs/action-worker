# Fongap Labs 治理全景（一页纸）

## 权威金字塔

```
机器合同 / 策略 / 规则
        ↓
Action Worker 共用治理
        ↓
项目架构 / 项目边界
        ↓
项目实现文档
        ↓
README / 示例
```

冲突时按上述顺序裁决。项目规则可收紧共用规则，不得绕过安全边界、PR 门禁或跨仓库凭据边界。

---

## 核心流程

```
PR → Notify Bridge → PR Governance (Security / CI Evidence / PR 策略) → validate-merge → 合并
                                              ↓
                                        门禁后 AI Review（仅参考）

main push → Intake → Central CI → Main Write Guard → 可信 main SHA
                                                      ↓
                                              Release / Deploy / Task / Publication 均需可信 SHA
```

- **Security Gate**：确定性检查，覆盖公开/私有仓库，硬边界
- **validate-merge**：唯一合并权限，AI Review 不参与
- **Main Write Guard**：所有受管仓库共用的 main 来源硬边界；无法证明来自合法 PR 合并的 SHA 视为不可信，拒绝 Release/Deploy/Publication/特权执行

---

## 语言与文档分层（唯一权威）

| 文档类型 | 语言 | 说明 |
|----------|------|------|
| 机器读取文档（contracts/policies/rules/skills/CLAUDE.md/AGENTS.md） | **英文** | 精确、无歧义、结构化、可验证 |
| 人类阅读文档（README/指南/治理文档/proposals） | **中文** | 单一文件，无镜像；先说“是什么”，再讲“怎么做” |
| 工程产出（PR标题/CHANGELOG/代码注释/工作流/日志/错误/测试） | **英文** | 严禁中英混用 |
| 例外 | — | 面向用户的界面文案、本地化资源、纯数据文件、HTML模板文案 |

---

## 关键文档速查

| 需求 | 读哪份 |
|------|--------|
| 新仓库接入最小配置 | `05-integration-guide.md` §2–4 |
| 命名变量/Secret/工作流 | `03-naming-conventions.md` |
| 写 PR 标题/CHANGELOG | `04-changelog-conventions.md` |
| 发布/部署手动操作 | `06-release-deploy-guide.md` §1–3 |
| Main Write Guard 失败怎么办 | `07-main-write-guard.md` §4 |
| 修改共用规则清单 | `GOVERNANCE_CHANGE_CHECKLIST.md` |
| 术语表（英文键+中文解释） | `TERMINOLOGY.md` |

---

## 机器执行闭环

```
contracts/   输入输出合同
policies/    确定性策略
rules/       AI 审查策略
.github/actions/  合并执行
workflows/   编排
tests/       治理回归测试
```

只存在于 Markdown 而没有对应机器约束的重要规则，尚未闭环。

---

## 平台能力边界

- 公开仓库：GitHub rulesets + 中央门禁双重保护
- GitHub Free 私有仓库：无规则集/保护分支，中央门禁为流程约束，**平台功能缺失永远不能成为绕过中央门禁的理由**
- Main Write Guard 在写入后隔离不可信 SHA，补足平台短板