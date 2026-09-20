# CHANGELOG 规范

Action Worker 统一使用一套变更分类贯穿 PR、Agent、CHANGELOG 与 Release。

## 0. Language

PR 标题、CHANGELOG 条目和 Release Notes 的工程摘要必须使用英文。

禁止：

- 中文 CHANGELOG 条目；
- 中英文混写的 CHANGELOG 条目；
- 中文 PR summary；
- 为不同仓库自行选择不同 CHANGELOG 语言。

中文仅可出现在明确以中文维护的说明文档、UI 或本地化资源中；不得进入工程 CHANGELOG。

## 1. 唯一变更分类

只允许以下 11 类：

| Type | 含义 |
|---|---|
| `feat` | 新增功能或能力 |
| `fix` | 修复缺陷 |
| `docs` | 仅文档 |
| `style` | 仅格式或样式，不改变逻辑 |
| `refactor` | 重构，不新增功能、不修复缺陷 |
| `perf` | 性能优化 |
| `test` | 测试新增或调整 |
| `build` | 构建、依赖、打包 |
| `ci` | CI/CD、GitHub Actions |
| `chore` | 其他维护性工作 |
| `revert` | 回滚已有变更 |

禁止再定义 Added、Changed、Fixed、Internal 等第二套分类。

## 2. 变更属性

以下不是 Type，只是属性：

```text
breaking
security
migration
```

一个 PR 只有一个主 Type，可以同时拥有多个属性。

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

PR 标题必须采用 Conventional Commits 风格：

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

- Type 必须来自上述 11 类；
- scope 可选，只描述影响范围；
- `!` 表示 breaking；
- summary 必须使用英文并描述结果，不写 `update files`、`misc changes` 等无意义描述；
- 一个 PR 只允许一个主 Type。

## 4. CHANGELOG 文件

项目统一使用：

```text
CHANGELOG.md
```

文件至少包含：

```markdown
# Changelog

## [Unreleased]
```

所有待发布记录写入 `[Unreleased]`。

不使用 Added / Changed / Fixed 等章节，不再做分类转换。

## 5. CHANGELOG 条目

条目直接使用同一套 Type：

```markdown
- feat: 增加 PR 仓库白名单校验。
- fix [security]: 阻止 PR Sandbox 继承中央 Secret。
- feat [breaking, migration]: 替换旧版认证配置格式。
- perf: 降低 Provider 路由延迟。
```

格式：

```text
- type: summary
- type [attribute]: summary
- type [attribute, attribute]: summary
```

属性只允许：

```text
breaking
security
migration
```

PR 标题使用 `!` 时，对应 CHANGELOG 条目必须包含 `breaking`。

## 6. 什么时候必须写 CHANGELOG

默认必须记录：

```text
feat
fix
perf
revert
```

以及任何带有以下属性的变更：

```text
breaking
security
migration
```

默认不要求记录：

```text
docs
style
refactor
test
build
ci
chore
```

如果所谓 `refactor`、`ci`、`build` 实际改变了对外行为，则分类本身就不准确，应重新分类为 `feat`、`fix`、`perf` 等，而不是通过例外规则绕过。

## 7. Agent 默认职责

正常 PR 不要求人工逐项判断。

执行 Agent 在代码完成后必须：

1. 读取最终 diff，而不是根据最初任务描述猜测；
2. 从 11 类中选择唯一主 Type；
3. 判断是否存在 breaking / security / migration 属性；
4. 设置或修正 PR 标题；
5. 按本规范决定是否更新 `CHANGELOG.md`；
6. CHANGELOG 内容使用英文，只描述实际结果，不罗列文件修改。

Review Agent / Critic 必须重新检查：

- Type 与实际 diff 是否一致；
- breaking 是否被漏标；
- security / migration 是否被漏标；
- 必须记录的 PR 是否遗漏 CHANGELOG；
- CHANGELOG 是否使用英文并描述真实行为而非实现过程。

只有证据不足、业务语义无法从代码/测试/文档确定，或涉及不可逆高风险决策时，才升级给人确认。

## 8. 禁止事项

禁止：

```text
update files
fix bug
refactor code
misc changes
various improvements
```

也禁止：

- 同一 PR 同时声明多个主 Type；
- 用 `chore` 掩盖真实的 feat / fix / breaking；
- 把 security 当作主 Type；
- 把 breaking 当作主 Type；
- 用第二套 Added / Changed / Fixed 分类；
- 因为 Agent 不确定就静默省略 CHANGELOG。

## 9. Release

Release Notes 直接消费同一套 Type。

可以在展示层隐藏低价值类别，例如：

```text
docs
style
refactor
test
build
ci
chore
```

但底层分类不转换、不重命名。

## 10. 最短规则

> 一个 PR 一个 Type；PR 标题与 CHANGELOG 使用英文；Type 统一使用 Conventional Commits；breaking / security / migration 只是属性；CHANGELOG 不再维护第二套分类。
