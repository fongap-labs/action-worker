# 共用治理变更清单

## 1. 影响范围

同一变更必须同步检查所有权威层。

### ❌ 错误做法 / 反面教材

只修改文档或策略。

```text
修改 policies/release.json → 直接提交
```

### ✅ 正确做法 / 规范范例

同步合同、实现、测试和文档。

```text
policies/ → scripts/ → tests/ → docs/
```

必要时同步 `contracts/`、`rules/` 和 `TERMINOLOGY.md`；无关文件不得批量改动。

## 2. 验证要求

全部相关检查成功后才能合并。

### ❌ 错误做法 / 反面教材

忽略失败测试。

```text
仅检查 Markdown 格式 → 合并
```

### ✅ 正确做法 / 规范范例

执行全量校验并核对策略。

```bash
npm run check
node scripts/apply-repository-settings.ts <owner/name> true
```

仅在修改仓库设置时执行第二项只读预览。安全边界保持失败即关闭。

## 3. 变更记录

提交标题限三类，日志精炼中文。

### ❌ 错误做法 / 反面教材

使用旧类型或片段。

```text
docs: change governance rules
changelog.d/governance.md
```

### ✅ 正确做法 / 规范范例

标题与中文记录保持一致。

```text
chore(governance): simplify shared rules
```

```markdown
## [Unreleased]

- 维护: 精简共用治理规则与校验流程。
```

完整限制见 `04_CHANGELOG_CONVENTIONS.md`。

## 4. 合并后核查

验证受管仓库未受跨仓库故障影响。

### ❌ 错误做法 / 反面教材

仅检查本仓库状态。

```text
中央校验通过 → 不核查受管仓库
```

### ✅ 正确做法 / 规范范例

按修改范围检查中央和受管链路。

```text
中央校验 → 受管仓库合并门禁 → 主分支来源审计
          → 相关发布或部署验证
```

权限不足或凭据缺失必须明确失败，不使用自动回退。
