# 提案 AW-008：CHANGELOG 自动生成与按仓库发版

状态：**已决定：方案 C**（2026-10-23，owner 确认）。方案 C = 中文 CHANGELOG 与六类类别（本提案选项 B 的语言与分类）+ 中央生成、经 PR 合入、中央打 tag 与 Release、版本只来自发布输入或中央自动计算（本提案选项 A 的发布部分）。

实施进度：

- 已实施：类别映射与条目格式（`policies/release.json`）、门禁（`scripts/validate-change-record.ts`）、语言检查（`scripts/validate-engineering-language.ts`）、版本小节生成（`scripts/changelog-release.ts`，纯函数，含测试）、治理文档与合同测试。
- 未实施：中央发布流程中的"生成 CHANGELOG → 开 PR → 合并后打 tag 与创建 Release"两阶段流程。`publish-release.ts` 目前仍直接在目标仓库创建 tag 与 Release，不写 CHANGELOG。见下文"待实施的两阶段发布"。
- 未实施：业务仓库中既有的英文 `[Unreleased]` 条目迁移（action-worker 有 250 条英文条目，其余仓库同样存在）。见下文"既有英文条目"。
- 未实施：以条目文件（`changelog.d/`）替换 `CHANGELOG.md merge=union`。owner 已于 2026-10-23 同意该方案，见下文"条目文件"。

## 方案 C 的默认决定

以下默认值由实施时选定，owner 可以修改，修改后需同步更新 `policies/release.json`、`docs/04_CHANGELOG_CONVENTIONS.md` 与对应测试。

1. 类别顺序：新增、变更、弃用、移除、修复、安全。
2. 类别映射：`feat` → 新增、变更、弃用；`fix` → 修复、变更；`perf` → 变更；`revert` → 变更、修复；安全类别只能由 `security` 属性产生，且带 `security` 属性的条目必须是安全类别。
3. 摘要必须含汉字，并拒绝常见乱码（`â€`、`â–`、`Â` 加空白、U+FFFD）。英文标识符可以保留在中文句子中。
4. PR 类型仍使用 11 种类型，PR 标题保持英文。
5. 破坏性变更必须归入 `feat`、`fix`、`perf` 或 `revert`。`refactor` 等不要求条目的类型不能承载破坏性变更。
6. 版本小节标题链接到 GitHub Release 地址，格式为 `## [版本](release-url) - 日期`。

## 既有英文条目

`[Unreleased]` 中的英文条目（action-worker 有 250 条）不符合新格式，`promoteUnreleased` 会拒绝它们。发布前必须先处理，可选：

- 将既有条目逐条翻译为中文并归入六类类别（工作量大，需要逐条核对）；
- 或只对新条目强制新格式，既有条目在下一次发布时整体放入一个标注"历史条目"的小节（需要 owner 同意这种例外）。

## 待实施的两阶段发布

1. 发布启动（人工输入或中央自动计算版本）后，中央读取 `[Unreleased]`，生成版本小节，在目标仓库创建 `aw/changelog/<tag>` 分支并开 PR。
2. 等待 PR 经门禁合并。合并提交由 Main Write Guard 证明来源，之后才允许打 tag。
3. 在合并提交上创建 tag 与 GitHub Release，发布的产物仍由中央构建。

该流程需要新的状态与等待机制，以及对 GitHub API 的实际调用验证，因此单独立项实施。

## 条目文件：替换 `merge=union`（已同意，待实施）

问题：`CHANGELOG.md` 的 `[Unreleased]` 顶部是所有 PR 都会改的同一段行。`merge=union` 只在本地 git 合并时生效，GitHub 网页端不执行它，因此 PR 仍报告冲突。即使在本地合并，两边都加入相同行时，union 也会保留两份，形成重复条目。PR #986 同时遇到了这两个问题。

决定：每个变更不再直接改 `CHANGELOG.md`，而是新增一个条目文件。

1. **位置与命名**：`changelog.d/<slug>.md`。`<slug>` 由作者取一个仓库内唯一的短英文 kebab-case 名，例如 `csi-verdict-supersede`。一个文件可以包含多条条目。
2. **内容**：沿用 `docs/04_CHANGELOG_CONVENTIONS.md` §5 的条目格式（`- 类别 [属性]: 中文摘要`）。
3. **门禁**：需要条目的 PR 必须新增至少一个条目文件。`scripts/validate-change-record.ts` 沿用现有的格式、类别、安全配对与乱码检查，并拒绝同一仓库中重复的文件名。
4. **汇总**：发布阶段一（见上文"待实施的两阶段发布"）时，中央读取 `changelog.d/*.md`，按六类顺序写入版本小节，并在同一个 PR 中删除这些条目文件。
5. **`[Unreleased]`**：`CHANGELOG.md` 保留该标题。新变更不再把条目写入这里，待发布的条目只存在于 `changelog.d/`。实施前已经在 `[Unreleased]` 中的条目保持原位，在下一次发布时与条目文件一起汇总。
6. **冲突**：两个 PR 各自新增不同文件名时不会冲突。两个 PR 选了同一文件名会产生 add/add 冲突，概率很低，解决办法是改名；不会产生静默重复。
7. **`.gitattributes`**：实施时删除 `CHANGELOG.md merge=union`。

为什么不选其他办法：去掉 `merge=union` 只是回到手工解冲突，而加一个重复检查只是把重复变成红色检查。两者都保留了共享行，问题会反复出现。

实施范围（单独 PR，按 `docs/GOVERNANCE_CHANGE_CHECKLIST.md`）：`docs/04_CHANGELOG_CONVENTIONS.md` §4、§9；`scripts/changelog-release.ts`（输入从 `[Unreleased]` 扩展到条目文件）；`scripts/validate-change-record.ts`（文件位置与重复名检查）；`.gitattributes`；对应回归测试。

本设计 PR 只改文档，不改变任何执行逻辑。在实施 PR 合并前，`docs/04` §4 描述的现行规则仍然有效。

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

## 需要 owner 决定的问题（已于 2026-10-23 决定为方案 C，上文记录实际取值）

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
