# 变更记录规范

## 1. 变更类型

仅允许三种类型。

### ❌ 错误做法 / 反面教材

使用其他类型。

```text
docs: update guides
refactor: simplify runner
perf: reduce latency
```

### ✅ 正确做法 / 规范范例

按实际效果选择类型。

```text
feat: add task routing
fix: resolve runner timeout
chore: update guides and dependencies
```

| 类型 | 用途 | 版本建议 | 中文类别 |
|---|---|---|---|
| `feat` | 新增功能或行为 | 次版本 | 新增 |
| `fix` | 修复缺陷或安全问题 | 修订版本 | 修复 |
| `chore` | 其他维护工作 | 默认不升级 | 维护 |

## 2. 提交标题

标题使用英文标准格式。

### ❌ 错误做法 / 反面教材

使用图标、中文摘要或新类型。

```text
:sparkles: add feature
fix: 修复超时
build: update dependencies
```

### ✅ 正确做法 / 规范范例

范围可省略，类别固定。

```text
feat(agent): add task routing
fix(auth): reject invalid token
chore: update dependencies
```

## 3. 破坏性变更

破坏性变更增加标记，不增加类型。

### ❌ 错误做法 / 反面教材

新建第四种类型。

```text
breaking: replace authentication contract
```

### ✅ 正确做法 / 规范范例

使用标准破坏性标记。

```text
feat(auth)!: replace authentication contract

BREAKING CHANGE: the previous contract is removed.
```

`breaking`、`security`、`migration` 是属性，非变更类型。

## 4. 单一文件

仅允许一个变更记录文件。

### ❌ 错误做法 / 反面教材

新增片段文件。

```text
changelog.d/add-feature.md
changelog.d/fix-runner.md
```

### ✅ 正确做法 / 规范范例

直接更新未发布区域。

```markdown
## [Unreleased]

- 新增: 支持任务自动分派。
- 修复: 修复取消任务后状态挂起的问题。
```

不得创建、读取 `changelog.d/` 或以 `merge=union` 绕过冲突；普通合并请求不得修改已发布版本。顶层标题 `# 更新日志` 与未发布标题 `## [Unreleased]` 固定，不得改名或重复；已发布版本及其类别小标题保持原样。

## 5. 中文摘要

只写实际变化，不超过 140 个 Unicode 码点。门禁按 Unicode 码点计数，摘要还必须包含中文文本。

### ❌ 错误做法 / 反面教材

使用英文或过程性废话。

```markdown
- fix: Fix the runner issue.
- 维护: 调整了一些文件和逻辑。
```

### ✅ 正确做法 / 规范范例

类别仅为新增、修复、维护。

```markdown
- 新增: 支持跨仓库任务调度。
- 修复: 修复取消运行后状态长期挂起的问题。
- 维护: 统一治理文档格式。
- 修复 [security]: 拒绝未授权部署。
```

`feat`、`fix`、`chore` 均须记录匹配类型的条目；专用 `chore(release)` 以严格的版本小节迁移代替新增未发布条目。破坏性变更还必须添加 `breaking` 属性。

## 6. 自动生成与发布

智能体提议，门禁验证，产物通过才发布。

### ❌ 错误做法 / 反面教材

仅按标题生成并直接发布。

```text
标题 → 生成版本 → 正式发布
```

### ✅ 正确做法 / 规范范例

根据最终差异生成并校验。

```text
最终差异 → 建议类型 → 英文标题和中文条目
         → 中央门禁 → 版本小节 → 产物校验 → 正式发布
```

`commitlint` 仅校验格式；`policies/release.json` 及 `scripts/validate-change-record.ts` 是机器权威。不接受旧类型别名。
