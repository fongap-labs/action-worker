# CHANGELOG 约定

Action Worker 在 PR、Agent、CHANGELOG 与 Release 之间使用同一套变更分类。PR 标题使用 11 种工程类型；CHANGELOG 条目使用 6 个面向读者的类别，并由 PR 类型映射得到。

**语言规则**：PR 标题与工程 diff 使用英文；CHANGELOG 条目与 Release 版本说明使用中文。详见 `01_SHARED_GOVERNANCE.md` §2。

**实施状态**：类别映射、条目格式与门禁已实施（`policies/release.json`、`scripts/changelog-release.ts`、`scripts/validate-change-record.ts`）。发布时由中央生成 CHANGELOG 并经 PR 合入的流程尚未实施，见 `docs/proposals/AW-008-changelog-release-automation.md`。

---

## 1. PR 类型与 CHANGELOG 类别

PR 标题只允许以下 11 种类型，决定 PR 治理与版本计算：

| 类型 | 含义 |
|------|------|
| `feat` | 新功能或新能力 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档 |
| `style` | 仅格式或风格，无逻辑变化 |
| `refactor` | 不新增功能、不修复缺陷的重构 |
| `perf` | 性能改进 |
| `test` | 新增或调整测试 |
| `build` | 构建、依赖、打包 |
| `ci` | CI/CD、GitHub Actions |
| `chore` | 其他维护工作 |
| `revert` | 撤销更早的变更 |

CHANGELOG 条目只允许以下 6 个类别，按此顺序显示：

| 类别 | 含义 |
|------|------|
| 新增 | 新功能或新能力 |
| 变更 | 既有行为的调整、性能改进、撤销 |
| 弃用 | 仍可用，但计划移除的功能 |
| 移除 | 已删除的功能或字段 |
| 修复 | 缺陷修复 |
| 安全 | 安全相关变更，必须带 `security` 属性 |

类别由 PR 类型映射得到，映射表维护在 `policies/release.json` 的 `changelog_category_types` 中：

| PR 类型 | 允许的 CHANGELOG 类别 |
|---------|-----------------------|
| `feat` | 新增、变更、弃用 |
| `fix` | 修复、变更 |
| `perf` | 变更 |
| `revert` | 变更、修复 |

安全条目例外：带 `security` 属性的条目必须使用 `安全` 类别，且 `安全` 类别的条目必须带 `security` 属性；此类条目可满足任何 PR 类型的 CHANGELOG 要求。

不得在 CHANGELOG 中使用英文类型名（如 `fix:`）或 Added/Changed/Fixed 等英文小节名。

---

## 2. 变更属性

以下只是属性，**不是类型**：

```
breaking
security
migration
```

一个 PR 有且只有一个主类型，可带多个属性。

示例：
```
type: feat
attributes: breaking, migration
```
或：
```
type: fix
attributes: security
```

---

## 3. PR 标题

遵循 Conventional Commits 风格：

```
type: summary
type(scope): summary
type!: summary
type(scope)!: summary
```

示例：
```
feat: add repository allowlist validation
fix(router): stop retrying a disabled provider
refactor: simplify PR plan resolution
feat(auth)!: replace legacy authentication contract
```

规则：
- 类型必须来自 §1 的 11 种类型
- scope 可选，只描述受影响区域
- `!` 标记破坏性变更
- summary 使用英文，描述实际结果；`update files`、`misc changes` 等无实义摘要禁止
- 一个 PR 只有一个主类型

---

## 4. CHANGELOG 文件

每个项目使用：
```
CHANGELOG.md
```

文件至少包含：
```markdown
# Changelog

## [Unreleased]
```

所有未发布条目放在 `[Unreleased]` 之下。`[Unreleased]` 只保存条目，不写小节标题；发布后，条目被移入一个版本小节，小节下按 §1 的类别分组。

并发变更时，仓库的 `.gitattributes` 应对 `CHANGELOG.md` 声明 `merge=union`：每个变更都在 `[Unreleased]` 顶部加入自己的条目，两个同时打开的变更会碰到同一段行；并集合并会同时保留两边的条目。条目一旦发布即视为不可变，不要回头改写已发布的条目。

版本小节的标题链接到该版本的 GitHub Release：

```markdown
## [1.2.0](https://github.com/<owner>/<repo>/releases/tag/<tag>) - 2026-10-23

### 新增

- 增加导出命令。
```

---

## 5. CHANGELOG 条目

每条条目一行，格式为：

```
- 类别: 中文摘要
- 类别 [属性]: 中文摘要
- 类别 [属性, 属性]: 中文摘要
```

示例：
```markdown
- 新增: 增加仓库白名单校验。
- 安全 [security]: 阻止 PR 沙箱继承中央密钥。
- 新增 [breaking, migration]: 替换旧的认证配置格式。
- 变更: 降低提供方路由延迟。
```

规则：
- 类别必须是 §1 的 6 个类别之一；
- 摘要必须是中文，只描述实际结果，不列出变更文件；英文标识符（函数名、配置键）可保留在句子中；
- 摘要不得含乱码（例如 `â€“`、`â–?`、`�`），需要符号时直接输入正确字符；
- 允许属性：`breaking`、`security`、`migration`（定义与用法见 §2）；
- 当 PR 标题使用 `!` 时，其 CHANGELOG 条目**必须**包含 `breaking`；
- 破坏性变更必须归入 `feat`、`fix`、`perf` 或 `revert` 类型；`refactor` 等不要求条目的类型不能承载破坏性变更，应当重新分类。

---

## 6. 何时必须写 CHANGELOG 条目

默认必须写的类型：
```
feat
fix
perf
revert
```
以及带有以下任一属性的所有变更：
```
breaking
security
migration
```

默认不要求写的类型：
```
docs
style
refactor
test
build
ci
chore
```

> 如果某个所谓的 `refactor`、`ci` 或 `build` 实际上改变了外部行为，问题在于分类本身。应重新分类为 `feat`/`fix`/`perf` 等，而非用例外绕过规则。

---

## 7. Agent 的默认职责

普通 PR 不需要人逐项决定。代码完成后，执行的 Agent **必须**：

1. 阅读最终的 diff，而非凭原始任务描述猜测
2. 从 11 种类型中选择且只选择一个主类型
3. 判断 breaking / security / migration 属性是否适用
4. 设置或修正 PR 标题（英文）
5. 依据本约定判断 `CHANGELOG.md` 是否必须更新
6. 用中文撰写 CHANGELOG 条目，选择 §1 的类别，只描述实际结果，不列出变更文件，不产生乱码

Review Agent 或审查者**必须**再次检查：
- 类型是否与实际 diff 相符
- 是否遗漏 breaking
- 是否遗漏 security / migration
- 应当有 CHANGELOG 条目的 PR 是否缺失条目
- 类别是否与 PR 类型映射一致，安全类别与 `security` 属性是否一一对应
- CHANGELOG 条目是否为中文，是否描述真实行为而非实现过程，是否含乱码

只有在证据不足、无法从代码/测试/文档确定业务含义，或涉及不可逆高风险决策时，才升级给人处理。

---

## 8. 禁止事项

禁止的摘要：
```
update files
fix bug
refactor code
misc changes
various improvements
```

同样禁止：
- 一个 PR 声明多个主类型
- 用 `chore` 掩盖真实的 feat / fix / 破坏性变更
- 把 security 作为主类型
- 把 breaking 作为主类型
- 在 CHANGELOG 中使用 §1 之外的类别，或使用英文类别名与 Added/Changed/Fixed 小节
- 在 PR 类型与 CHANGELOG 类别之外另立分类体系
- 因 Agent 不确定而悄悄省略应有的 CHANGELOG 条目
- 在 CHANGELOG 中写英文条目或乱码

---

## 9. Release

Release 版本说明使用 §1 的类别分组，顺序与 `[Unreleased]` 小节一致。

CHANGELOG 标题**永远不决定或约束** Release 版本。版本来自发布启动时输入的稳定 SemVer；`release-app.yml` 的 `requested_version` 也可以留空，留空时 Action Worker 按上次 `<release_key>-vX.Y.Z` 标签之后的 Conventional Commits 自动计算下一个稳定版本（沿用 SemVer 0.x 规则；跨度内出现无法解析的提交标题会整次失败，改用显式版本即可）。

Release 的标签与 GitHub Release 由 `scripts/publish-release.ts` 创建；版本说明的唯一权威是产品清单里的 `release_notes` 字段。只有它为空字符串时，发布流程才会用自动生成的提交跨度清单填充；维护者手写的值永远优先。

目标流程（尚未实施）：发布时由中央依据 `[Unreleased]` 生成版本小节，经 PR 合入目标仓库，合并后在合并提交上打 tag 并创建 Release。

---

## 10. 最短规则

> 一个 PR，一个类型；PR 标题使用英文，CHANGELOG 条目使用中文并选择六类类别之一；类型遵循 Conventional Commits；breaking / security / migration 只是属性；版本只来自发布输入。

---

## 11. 相关引用

- 语言与文档分层：`01_SHARED_GOVERNANCE.md` §2
- 变更类型与属性定义：`TERMINOLOGY.md`
- 映射与类别的机器定义：`policies/release.json`
- PR 标题格式：本文件 §3
- Agent 入口与职责：`01_SHARED_GOVERNANCE.md` §5–6
- Release 版本唯一来源：`01_SHARED_GOVERNANCE.md` §3 与 `06_RELEASE_DEPLOY_GUIDE.md` §4
- 待实施的发布流程：`docs/proposals/AW-008-changelog-release-automation.md`
