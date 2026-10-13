# CHANGELOG 约定

Action Worker 在 PR、Agent、CHANGELOG 与 Release 之间使用同一套变更分类。

## 0. 语言

PR 标题、CHANGELOG 条目与 Release 说明的工程摘要必须使用英文。

禁止：

- 中文的 CHANGELOG 条目；
- 中英混用的 CHANGELOG 条目；
- 中文的 PR 摘要；
- 每个仓库各自选择 CHANGELOG 语言。

中文只可以出现在面向用户的界面文案与本地化资源中；它永远不进入工程 CHANGELOG。

## 1. 唯一的变更分类

只允许以下 11 种类型：

| 类型 | 含义 |
|---|---|
| `feat` | 新功能或新能力 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档 |
| `style` | 仅格式或风格，无逻辑变化 |
| `refactor` | 在不新增功能、不修复缺陷的前提下重构 |
| `perf` | 性能改进 |
| `test` | 新增或调整测试 |
| `build` | 构建、依赖、打包 |
| `ci` | CI/CD、GitHub Actions |
| `chore` | 其他维护工作 |
| `revert` | 撤销更早的变更 |

不得另行定义第二套分类，例如 Added、Changed、Fixed 或 Internal。

## 2. 变更属性

以下只是属性，不是类型：

```text
breaking
security
migration
```

一个 PR 有且只有一个主类型，可以带有多个属性。

例如：

```text
type: feat
attributes: breaking, migration
```

或：

```text
type: fix
attributes: security
```

## 3. PR 标题

PR 标题遵循 Conventional Commits 风格：

```text
type: summary
type(scope): summary
type!: summary
type(scope)!: summary
```

示例：

```text
feat: add repository allowlist validation
fix(router): stop retrying a disabled provider
refactor: simplify PR plan resolution
feat(auth)!: replace legacy authentication contract
```

规则：

- 类型必须来自上述 11 种；
- scope 可选，只描述受影响的区域；
- `!` 标记破坏性变更；
- summary 使用英文，并描述实际结果；`update files`、`misc changes` 之类没有实际含义的摘要不允许使用；
- 一个 PR 只有一个主类型。

## 4. CHANGELOG 文件

每个项目使用：

```text
CHANGELOG.md
```

文件至少包含：

```markdown
# Changelog

## [Unreleased]
```

所有尚未发布的条目都放在 `[Unreleased]` 之下。

不设 Added / Changed / Fixed 小节，也不做分类之间的转换。

## 5. CHANGELOG 条目

条目直接使用上述类型：

```markdown
- feat: validate the PR repository allowlist.
- fix [security]: stop the PR sandbox from inheriting central secrets.
- feat [breaking, migration]: replace the legacy authentication configuration format.
- perf: reduce provider routing latency.
```

格式：

```text
- type: summary
- type [attribute]: summary
- type [attribute, attribute]: summary
```

允许的属性：

```text
breaking
security
migration
```

当 PR 标题使用 `!` 时，其 CHANGELOG 条目必须包含 `breaking`。

## 6. 何时必须写 CHANGELOG 条目

默认必须写的类型：

```text
feat
fix
perf
revert
```

以及带有以下任一属性的所有变更：

```text
breaking
security
migration
```

默认不要求写的类型：

```text
docs
style
refactor
test
build
ci
chore
```

如果某个所谓的 `refactor`、`ci` 或 `build` 变更实际上改变了外部行为，问题在于分类本身。应将其重新分类为 `feat`、`fix`、`perf` 等，而不是用例外绕过规则。

## 7. Agent 的默认职责

普通 PR 不需要人逐项决定。代码完成之后，执行的 Agent 必须：

1. 阅读最终的 diff，而不是凭原始任务描述猜测；
2. 从 11 种类型中选择且只选择一个主类型；
3. 判断 breaking / security / migration 属性是否适用；
4. 设置或修正 PR 标题；
5. 依据本约定判断 `CHANGELOG.md` 是否必须更新；
6. 用英文撰写 CHANGELOG 内容，只描述实际结果，不列出变更的文件。

Review Agent 或审查者必须再次检查：

- 类型是否与实际 diff 相符；
- 是否遗漏了 breaking；
- 是否遗漏了 security / migration；
- 应当有 CHANGELOG 条目的 PR 是否缺失条目；
- CHANGELOG 是否使用英文，并描述真实行为，而不是描述实现过程。

只有在证据不足、无法从代码、测试或文档确定业务含义，或涉及不可逆的高风险决策时，才升级给人处理。

## 8. 禁止事项

禁止的摘要：

```text
update files
fix bug
refactor code
misc changes
various improvements
```

同样禁止：

- 一个 PR 声明多个主类型；
- 用 `chore` 掩盖真实的 feat / fix / 破坏性变更；
- 把 security 作为主类型；
- 把 breaking 作为主类型；
- 使用第二套 Added / Changed / Fixed 分类；
- 因 Agent 不确定而悄悄省略应有的 CHANGELOG 条目。

## 9. Release

Release 说明直接使用相同的类型。

CHANGELOG 的标题永远不决定或约束 Release 版本。版本只来自发布启动时输入的版本。

展示层可以隐藏低价值的类型，例如：

```text
docs
style
refactor
test
build
ci
chore
```

但底层分类永远不被转换或重命名。

## 10. 最短规则

> 一个 PR，一个类型；PR 标题与 CHANGELOG 使用英文；类型遵循 Conventional Commits；breaking / security / migration 只是属性；CHANGELOG 不保留第二套分类。
