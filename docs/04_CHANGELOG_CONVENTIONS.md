# CHANGELOG 约定

Action Worker 在 PR、Agent、CHANGELOG 与 Release 之间使用同一套变更分类。

**语言规则**：PR 标题、CHANGELOG 条目、Release 说明的工程摘要必须使用英文。详见 `01_SHARED_GOVERNANCE.md` §2。

---

## 1. 唯一的变更分类

只允许以下 11 种类型：

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

不得另行定义第二套分类（如 Added/Changed/Fixed/Internal）。

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
- 类型必须来自上述 11 种
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

所有未发布条目放在 `[Unreleased]` 之下。

**不设** Added/Changed/Fixed 小节，也不做分类间转换。

---

## 5. CHANGELOG 条目

条目直接使用上述类型：

```markdown
- feat: validate the PR repository allowlist.
- fix [security]: stop the PR sandbox from inheriting central secrets.
- feat [breaking, migration]: replace the legacy authentication configuration format.
- perf: reduce provider routing latency.
```

格式：
```
- type: summary
- type [attribute]: summary
- type [attribute, attribute]: summary
```

允许属性：
```
breaking
security
migration
```

当 PR 标题使用 `!` 时，其 CHANGELOG 条目**必须**包含 `breaking`。

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
4. 设置或修正 PR 标题
5. 依据本约定判断 `CHANGELOG.md` 是否必须更新
6. 用英文撰写 CHANGELOG 内容，只描述实际结果，不列出变更文件

Review Agent 或审查者**必须**再次检查：
- 类型是否与实际 diff 相符
- 是否遗漏 breaking
- 是否遗漏 security / migration
- 应当有 CHANGELOG 条目的 PR 是否缺失条目
- CHANGELOG 是否使用英文，并描述真实行为而非实现过程

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
- 使用第二套 Added/Changed/Fixed 分类
- 因 Agent 不确定而悄悄省略应有的 CHANGELOG 条目

---

## 9. Release

Release 说明直接使用相同的类型。

CHANGELOG 标题**永远不决定或约束** Release 版本。版本只来自发布启动时输入的版本。

展示层可隐藏低价值类型，例如：
```
docs
style
refactor
test
build
ci
chore
```
但底层分类永远不被转换或重命名。

---

## 10. 最短规则

> 一个 PR，一个类型；PR 标题与 CHANGELOG 使用英文；类型遵循 Conventional Commits；breaking / security / migration 只是属性；CHANGELOG 不保留第二套分类。

---

## 11. 相关引用

- 语言与文档分层：`01_SHARED_GOVERNANCE.md` §2
- 变更类型与属性定义：`TERMINOLOGY.md`
- PR 标题格式：`03_NAMING_CONVENTIONS.md` §1（外部边界名称）
- Agent 入口与职责：`01_SHARED_GOVERNANCE.md` §5–6
- Release 版本唯一来源：`01_SHARED_GOVERNANCE.md` §3 与 `06_RELEASE_DEPLOY_GUIDE.md` §4