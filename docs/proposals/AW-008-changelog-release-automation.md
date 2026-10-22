# 提案 AW-008：CHANGELOG 自动生成与按仓库发版

状态：**待 owner 决定**。本提案只记录决策选项、将要改动的规则范围与实施顺序，不含代码改动。在 owner 批准前，所有受管仓库保持现状。

## 背景

用户请求为 `fongap-labs` 下所有项目配置 CHANGELOG 自动生成与发版流程，要求包括：

1. 中文 CHANGELOG，采用 Keep a Changelog 的六类分类（新增 / 变更 / 弃用 / 移除 / 修复 / 安全）；
2. 每个仓库自带 `release.yml`，自动生成 CHANGELOG、升版本、打 tag、创建 GitHub Release；
3. 版本号回写到仓库文件（`package.json` 等）。

调查后发现，以下部分已经在现有治理中实现，或与现有治理直接冲突：

| 请求项 | 现状 | 冲突的规则 |
|---|---|---|
| `CHANGELOG.md` 含 `[Unreleased]` | 7 个仓库均已具备 | 无 |
| `merge=union`、英文条目 | 已具备 | 无 |
| 提交规范钩子 | action-worker、delta、app-source、internal-vault 已有 `.githooks/commit-msg`；delta-suite 用 pre-commit；ai-gateway 只有 commitlint 配置 | 无，但 `core.hooksPath` 在所有仓库均未设置，钩子未激活 |
| 中文 CHANGELOG，六类分类 | 与现状不一致 | `docs/01_SHARED_GOVERNANCE.md` §2：工程产出（含 CHANGELOG 条目）必须英文；`docs/04_CHANGELOG_CONVENTIONS.md` §1、§4、§8：只允许 11 种类型，不设 Added/Changed 小节，禁止第二套分类 |
| 业务仓库自带发布流程 | 发布由中央执行 | `docs/01_SHARED_GOVERNANCE.md` §1、§5：Release 进入 Action Worker；`docs/05_INTEGRATION_GUIDE.md` §15：新仓库不应自建发布路径 |
| 版本号回写 `package.json` | 版本仅来自发布启动时输入 | `docs/01_SHARED_GOVERNANCE.md` §3、`docs/proposals/AW-006-product-release-and-deploy.md` §2：版本不从仓库读取，CHANGELOG 标题也不决定版本 |
| `.github/release.yml` 分类 | Release notes 唯一权威是清单的 `release_notes` | `docs/04_CHANGELOG_CONVENTIONS.md` §9、`docs/06_RELEASE_DEPLOY_GUIDE.md` |

此外，`docs/07_MAIN_WRITE_GUARD.md` 规定：无法证明来自合法 PR 合并的 `main` SHA 视为不可信，不得用于发布或部署。因此，直接向 `main` 提交版本号或 CHANGELOG 更新，会使该 SHA 失去发布资格。

## 当前中央机制（事实）

- `scripts/publish-release.ts` 创建 tag 与 GitHub Release（约第 480–520 行），但不写 CHANGELOG。
- `scripts/compute-release-version.ts` 依据 Conventional Commits 计算版本，只接受 11 种类型的英文标题。
- `scripts/validate-change-record.ts` 校验 CHANGELOG 条目格式与英文；`scripts/validate-engineering-language.ts` 第 96 行规定 `CHANGELOG.md` 必须英文。
- `policies/release.json` 记录变更类型、必写类型与 CHANGELOG 路径。

## 选项

### 选项 A（推荐）：保持治理不变，由中央生成 CHANGELOG

- 在中央发布流程中，依据 `[Unreleased]` 与已合并 PR 标题生成版本小节，并通过 PR 合入目标仓库（因为直接写 `main` 不可信）。
- 版本仍只来自发布启动时输入或自动计算。
- 不改动 CHANGELOG 语言与 11 种类型规则，不新增业务仓库发布流程。
- 实施范围：`publish-release.ts`、`package-release-build.ts`、`release-app.yml`，以及对应合同测试。
- 业务仓库只需：激活 `core.hooksPath`（或在 README 中给出一次性命令）、补齐 ai-gateway 钩子、为 delta-suite 增加指向中央文档的 `CONTRIBUTING.md`。

### 选项 B：中文 Keep a Changelog，按仓库独立发版（用户请求的方向）

实施本选项必须同时推翻以下已有规则，每一项都需要 owner 明确批准：

1. **语言**：CHANGELOG 条目改为中文。需修改 `docs/01_SHARED_GOVERNANCE.md` §2、`scripts/validate-engineering-language.ts`（第 96 行）、`scripts/validate-change-record.ts` 的英文断言，以及 `tests/documentation-language.test.ts`、`tests/commit-attribution.test.ts`、`tests/control-flows.test.ts`。
2. **分类**：六类分类替代 11 种类型。需修改 `docs/04_CHANGELOG_CONVENTIONS.md` §1、§4、§5、§8，`policies/release.json` 的 `change_types` 与 `changelog_required_types`，以及上述校验脚本。PR 标题仍须遵守 Conventional Commits，否则无法从 PR 推导分类。
3. **发布权限**：业务仓库自建 `release.yml`。需修改 `docs/01_SHARED_GOVERNANCE.md` §1、§5，`docs/06_RELEASE_DEPLOY_GUIDE.md`，`docs/proposals/AW-006-product-release-and-deploy.md`，并撤销中央对这些仓库的 `release-source` 能力（`AW_REPOSITORY_POLICY`）。
4. **版本来源**：版本由 CHANGELOG 或仓库版本字段决定。需修改 `docs/01_SHARED_GOVERNANCE.md` §3 与 `docs/04_CHANGELOG_CONVENTIONS.md` §9。
5. **版本回写**：若采用，只能通过 release PR 完成，并满足 `docs/07_MAIN_WRITE_GUARD.md` 的 PR 合并证明要求。tag 应指向已经证明来源的合并提交，而不是新建提交。

按选项 B 完成后，业务仓库的 `release.yml` 需要：读取 `[Unreleased]`，生成中文小节，开 release PR 回写版本号，合并后在合并提交上打 tag，并创建 GitHub Release。

## 需要 owner 决定的问题

1. 选择选项 A 还是选项 B。
2. 若选 B：是否接受 §B 中的 5 项规则变更，以及撤销业务仓库的中央发布能力？
3. 若选 B：版本回写是否采用 release PR（推荐），还是只打 tag、不回写版本号？
4. 若选 B：中文 CHANGELOG 的分类是否要加入 `breaking` / `security` / `migration` 属性，还是完全用六类代替？

## 实施顺序（选项确定后）

按 `docs/GOVERNANCE_CHANGE_CHECKLIST.md` 执行，单独一个 PR，不得与业务仓库改动混在一起：

1. 更新 `policies/release.json` 与 `policies/attribution.json`（如涉及）。
2. 更新 `docs/01_SHARED_GOVERNANCE.md`、`docs/04_CHANGELOG_CONVENTIONS.md`、`docs/06_RELEASE_DEPLOY_GUIDE.md`、`docs/03_NAMING_CONVENTIONS.md`（如涉及）、`docs/00_GOVERNANCE_OVERVIEW.md`、`docs/TERMINOLOGY.md`。
3. 更新 `scripts/validate-change-record.ts`、`scripts/validate-engineering-language.ts`、`scripts/publish-release.ts` 或 `scripts/package-release-build.ts`。
4. 更新合同测试：`tests/documentation-language.test.ts`、`tests/commit-attribution.test.ts`、`tests/control-flows.test.ts`，并新增覆盖新规则的回归测试。
5. 运行 `npm run check`（`typecheck`、`lint`、`test`），并在本地确认失败项为既有失败或环境问题。
6. 业务仓库的改动只在治理 PR 合并后进行，每个仓库一个 PR。

## 本次未做的事

- 未修改任何受管仓库的文件。
- 未设置任何仓库的 `core.hooksPath`。
- 未创建 `release.yml`、`.github/release.yml`、husky 配置或 `commitlint.config.js`。
- 未验证中央发布流程的端到端行为。
