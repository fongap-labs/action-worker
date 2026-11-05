# 变更记录规范

> **三类变更、单一文件、中文精炼、自动优先。**

此规范同时适用于 Action Worker 和受管业务仓库。PR 与提交标题使用英文；\`CHANGELOG.md\` 的条目和发布说明使用中文。语言权威见 \`01_SHARED_GOVERNANCE.md\` §2。

---

## 1. 变更类型（Change Types）

只允许以下三类，不接受其他类型、别名或图标前缀。

| 类型 | 范围 | 默认版本影响 | CHANGELOG 类别 |
|------|------|--------------|----------------|
| \`feat\` | 新功能、新行为、新接口 | Minor | 新增 |
| \`fix\` | 缺陷、错误行为、安全修复 | Patch | 修复 |
| \`chore\` | 重构、配置、依赖、文档、测试、CI、样式及日常维护 | 无 | 维护 |

破坏性变更使用 \`!\` 或 Conventional Commits 的 \`BREAKING CHANGE:\` 描述，不增加第四类；版本升幅优先于上述默认值。**不为历史类型设置校验例外。**

## 2. 变更属性（Change Attributes）

\`breaking\`、\`security\`、\`migration\` 仅为元数据，**不是变更类型**，不创建额外类别。只有确实存在对应影响时才填写。新增安全修复仍是 \`fix\`，在中文条目中可标注 \`[security]\`。

## 3. PR 与提交标题（PR and Commit Titles）

采用统一格式：

\`\`\`text
feat: add agent scheduling
fix(auth): reject invalid token
chore: refresh documentation
feat(api)!: replace the legacy contract
\`\`\`

\`scope\` 可省略；摘要必须使用英文，表达实际效果。禁止 \`docs:\`、\`refactor:\`、\`ci:\`、\`perf:\` 等旧类型，也禁止 \`:sparkles:\`、\`:bug:\`、\`:rocket:\` 等图标前缀。

## 4. 单一文件（Single Changelog）

每个仓库只有一个变更记录来源：

\`\`\`text
CHANGELOG.md
\`\`\`

新条目直接写在 \`## [Unreleased]\` 下。**废除 \`changelog.d/\`**：不得创建、读取或发布片段文件，不保留兼容路径。

PR 可新增未发布条目，不得修改、删除已有条目或已发布版本小节。并行 PR 修改同一文件可能冲突；机器人应在最新 \`main\` 上重算并更新分支，不以 \`merge=union\` 绕开冲突检查。

## 5. 中文条目（Chinese Entries）

每条只写一项可理解的实际变化，不列文件、内部调用链或排查过程；一行一条，**摘要不超过 80 个字符**。

\`\`\`markdown
## [Unreleased]

- 新增: 支持自动分配多仓库任务。
- 修复: 修复 CI 取消后状态长期挂起的问题。
- 维护: 统一命名规范和文档索引。
- 修复 [security]: 拒绝未授权的部署请求。
\`\`\`

英文标识符可以保留在中文句子中，但不得写英文摘要、乱码或无意义语句。类别仅允许 **新增、修复、维护**。

## 6. 记录条件（When to Record）

\`feat\` 和 \`fix\` 必须有对应中文条目。\`chore\` 默认可省略；涉及破坏性行为时必须记录并标明 \`breaking\`。需要告知用户的维护变更可以主动记录，但不得把所有内部改动写进发布日志。

## 7. 自动生成（Automatic Generation）

执行 Agent 优先读取最终 diff，提出以下内容：

1. 一个 \`feat\`、\`fix\` 或 \`chore\` 类型。
2. 一条英文 PR 标题。
3. 需要时一条中文 CHANGELOG 摘要。

CI 校验标题类型、条目格式、类别映射及必要属性；**commitlint 只能校验格式，不能代替基于 diff 的语义判断**。不新增与 Action Worker 现有 PR 校验重复的独立权威。

## 8. 禁止事项（Prohibited Practices）

禁止额外类型、英文 CHANGELOG 摘要、空泛条目、无审查的自动发布，以及为旧类型登记豁免。禁止在 \`changelog.d/\` 新增文件或在发布时回退片段读取。

## 9. 发布流程（Release Process）

中央以可信 \`main\` 的 \`[Unreleased]\` 生成按三类分组的版本小节，并经 PR 与合并门禁后正式发布。Release Tag 只在资产校验通过后创建；CHANGELOG 标题不决定版本号。

自动版本建议基于 \`feat\`、\`fix\`、\`chore\` 与破坏性标记。跨度内存在不规范提交时应失败并明确指出，不自动回退到旧类型解析。

## 10. 最短规则（Quick Rules）

> 新增 / 修复 / 维护；三种标题类型；中文摘要最多 80 字符；一个 CHANGELOG 文件；语义由 Agent 建议，规则由 CI 验证。

## 11. 权威引用（Authoritative References）

- \`policies/release.json\`：类型、类别、记录要求。
- \`scripts/validate-change-record.ts\`：PR 与 CHANGELOG 校验。
- \`scripts/changelog-release.ts\`：版本小节生成。
- \`06_RELEASE_DEPLOY_GUIDE.md\`：发布与部署操作。
