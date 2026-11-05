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

冲突时按上述顺序裁决；完整裁决规则见 `01_SHARED_GOVERNANCE.md` §5。

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

## 语言与文档分层

唯一权威见 `01_SHARED_GOVERNANCE.md` §2：机器读取文档用英文，人类阅读文档用中文，工程产出（PR 标题、代码注释、工作流、日志）用英文，CHANGELOG 条目用中文；例外见该节。

---

## 关键文档速查

| 需求 | 读哪份 |
|------|--------|
| 新仓库接入最小配置 | `05_INTEGRATION_GUIDE.md` §2–4 |
| 命名变量/Secret/工作流 | `03_NAMING_CONVENTIONS.md` |
| 写 PR 标题/CHANGELOG | `04_CHANGELOG_CONVENTIONS.md` |
| 发布/部署手动操作 | `06_RELEASE_DEPLOY_GUIDE.md` §1–3 |
| Main Write Guard 失败怎么办 | `06_RELEASE_DEPLOY_GUIDE.md` §3（对策）；后果见 `07_MAIN_WRITE_GUARD.md` §4 |
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

完整闭环说明见 `01_SHARED_GOVERNANCE.md` §7。

---

## 平台能力边界

公开仓库、私有仓库与平台功能缺失的完整边界见 `01_SHARED_GOVERNANCE.md` §8。核心结论：平台功能缺失永远不能成为绕过中央门禁的理由。