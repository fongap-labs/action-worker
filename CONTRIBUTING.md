# 贡献指南 —— action-worker

本仓库是 fongap-labs 组织的治理中枢：中央 CI、PR 门禁、发布 / 部署流水线、任务执行与仓库设置都由它承载并分发给各业务仓库。

所有变更一律通过 Pull Request 进入 `main`（Squash merge）。组织级治理合同见 `docs/01_SHARED_GOVERNANCE.md`；本文只列贡献者立即需要的内容。

## 提交信息（Conventional Commits）

- 提交（即 Squash merge 后的 PR 标题）使用 `type(scope): summary` 格式，类型限定 11 种：`build`、`chore`、`ci`、`docs`、`feat`、`fix`、`perf`、`refactor`、`revert`、`style`、`test`。
- 破坏性变更用 `!`（如 `feat(api)!: drop the v1 protocol`）或正文中的 `BREAKING CHANGE` 脚注声明；安全、迁移等以属性标注（`feat [security]:`）。
- 摘要使用英文工程文本；非 ASCII、`Merge`/`Revert` 以外的裸消息会被拒绝。
- 权威定义见 `docs/04_CHANGELOG_CONVENTIONS.md`；本仓库与中央 PR 门禁执行同一套规则，本地的 `.githooks/commit-msg` 只是提前反馈。

本地安装消息校验：

```bash
git config core.hooksPath .githooks
# 或使用 commitlint 做整段历史检查（无额外依赖安装，只有 npx 下载）：
npx --yes --package=@commitlint/cli@19 commitlint --from origin/main --to HEAD
```

## CHANGELOG

每个 PR 在 `CHANGELOG.md` 的 `[Unreleased]` 下新增一条英文条目：`- type: summary`，方便日后自动汇总为 Release notes。

## Pull Request

1. 常规开发从 `main` 创建 `feat/*`、`fix/*`、`refactor/*`、`docs/*`、`test/*`、`ci/*`、`chore/*` 分支。
2. 一个 PR 只有一个目标；PR 标题遵守上面的提交格式。
3. 本地验证：`npm run check`（typecheck + lint + 全量测试，需要 Node 24 与 `npm ci`）。

## 受治理保护的变更

改动以下内容时，先阅读 `.github/GOVERNANCE_CHANGE_CHECKLIST.md`，并在 PR 描述中说明影响面：

- `docs/`（组织治理与操作手册）、`policies/`、`contracts/`、`templates/`
- `.github/workflows/`（工作流的类、命名、并发与权限由测试固化）
- `scripts/` 中承担门禁 / 发布 / 部署责任的脚本

行为变更必须有测试覆盖；门禁语义只允许收紧（fail closed），放宽需要明确的治理说明。
