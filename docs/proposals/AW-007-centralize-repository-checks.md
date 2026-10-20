# 提案 AW-007：把仓库自有检查脚本集中到中央

状态：**待 owner 决定**（AW-005 建议单独立项，本提案只立项与划定范围，不含实施）。AW-005 已采纳方案 A（标准工具用固定参数调用）与方案 C（配置文件与仓库自有检查脚本由 PR 控制、依靠 CODEOWNERS 评审）；本提案要关闭的是方案 C 留下的那个缺口。

## 背景

AW-005 实施之后，标准工具（`biome`、`tsc`）已经由中央脚本以固定参数调用，PR 无法再通过改 `package.json` 里的 `lint` / `typecheck` 来削弱它们。但 `ai-gateway` 的合并证据仍然大量依赖 PR 自己定义的命令。

`ai-gateway` 的 `.github/scripts/central-ci.sh` 目前执行：

```bash
npm ci
npx --no-install biome check .          # 标准工具，固定参数
npx --no-install tsc --noEmit           # 标准工具，固定参数
npm run validate:merge                  # PR 定义
node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" ai-gateway "$TARGET_ROOT" all   # 中央测试包
npm run check:deploy                    # PR 定义
npm run validate:deploy                 # PR 定义（仅非 PR 运行时）
```

而 `validate:merge` 展开后是：

```text
check                   = node scripts/check-syntax.mjs
check:deployment-config = node scripts/deployment-config-check.mjs
migrations:check        = node scripts/migrations-check.mjs
security:scan           = node scripts/secret-scan.mjs
check:docs              = node scripts/docs-check.mjs
lint                    = npx biome check .          ← 中央已另行调用
typecheck               = npx tsc --noEmit           ← 中央已另行调用
check:links             = node scripts/link-check.mjs
```

因此，一个 PR 只要把 `scripts/check-syntax.mjs` 改成 `exit 0`（或把它指向别处、把 `package.json` 里的 `validate:merge` 改成一条空命令），仍然会得到 `validate-merge=success`。这不是密钥泄露问题——代码在沙箱里运行、不接触中央密钥——而是**证据完整性**问题：CI 证据所声称的检查内容，可以由被检查的那个 PR 自己定义。

`check:deploy` 同理：它是 `cloudflare-wrangler.mjs deploy --dry-run` 的包装，而入口在 PR 的 `package.json` 里。

其他受管仓库的同类缺口较小，但形态不同：`internal-vault` 的 `python -m ruff check .` 受 PR 的 `ruff.toml` 控制；`delta` 与 `app-source` 以固定标志调用 `cargo`，但 PR 的 `Cargo.toml` lint 属性仍然生效。AW-005 已决定不对 `package.json` 与锁文件采用方案 B（会破坏 Dependabot 流程），因此本提案只处理"检查脚本"这一类。

## 目标

1. 让 `validate-merge` 所声称的每一项检查，其定义都不由被检查的 PR 控制。
2. 保持业务仓库的本地开发体验：`npm run <script>` 继续可用，开发者不需要额外环境。
3. 不改变 CI Evidence 的语义（`context=CI Evidence`、`validate-merge` 名称与合并门禁逻辑都不变）。
4. 不破坏 Dependabot 流程（`package.json` 与锁文件不进入 `CONTROL_PATHS`）。

## 方案

| | 思路 | 关闭的缺口 | 成本与代价 |
|---|---|---|---|
| **A** | 把检查脚本迁入中央测试包（`tests/packs/<repo>/`），由中央脚本在检出目录上运行；业务仓库保留同名 npm 脚本供本地使用 | 完整关闭：检查定义与被检查内容分离 | 中央仓库开始承载业务检查逻辑；检查规则变更要改两个仓库 |
| **B** | 业务仓库脚本保持原位，中央脚本以**固定参数**直接调用它们（不再经由 `npm run`） | 部分关闭：入口不再可被 PR 改写，但脚本内容仍由 PR 定义 | 成本最低；PR 仍可把脚本改成 `exit 0` |
| **C** | 把定义检查的文件加入 `CONTROL_PATHS`（lint / 类型检查配置、锁文件） | 关闭配置文件类缺口 | AW-005 已决定不整体采用；仅 lint 配置适用，且与 Dependabot 冲突 |

**建议**：以 A 为主、B 为过渡。C 留到需要时单独决定，本提案不捆绑。

## 范围

**纳入（`ai-gateway`，按阶段推进）**

| 脚本 | 阶段 | 说明 |
|---|---|---|
| `scripts/check-syntax.mjs` | 1 | 纯静态，无业务依赖 |
| `scripts/link-check.mjs` | 1 | 纯静态 |
| `scripts/docs-check.mjs` | 1 | 读仓库文档与配置 |
| `scripts/secret-scan.mjs` | 1 | 纯静态扫描 |
| `scripts/deployment-config-check.mjs` | 2 | 读部署配置，有业务语义 |
| `scripts/migrations-check.mjs` | 2 | 读迁移文件与 schema |
| `scripts/test.mjs` | 3 | 已有中央测试包 `tests/packs/ai-gateway` 覆盖大部分，可能只需删除重复 |
| `cloudflare-wrangler.mjs --dry-run` | 3 | 由中央以固定参数调用；它是产品 CLI 而非检查脚本，PR 仍可改其行为——这一点必须写进文档，不假装已关闭 |

**排除**

- `package.json` 与锁文件不进入 `CONTROL_PATHS`（Dependabot 流程）。
- 业务仓库的 npm 脚本不删除，开发者本地照旧使用。
- `internal-vault` / `delta` / `app-source` 的 lint 配置类缺口不在本提案范围；需要时按 C 单独决定。
- 产品的运行时行为检查（健康检查、指标检查）不动。

## 边界原则

CLAUDE.md 的共享治理规则要求业务仓库保留产品级检查。中央只接管**证据完整性敏感**的那部分：

- 判据是"这个检查的失败会让 `validate-merge` 失去意义"，而不是"这个检查属于哪个产品"。
- 与产品语义强相关、但被 PR 削弱也不影响证据有效性的检查（例如 `config-cli.mjs check`），留在业务仓库。
- 判定权归 `tests/packs/<repo>`：中央测试包里的套件由中央拥有，PR 无法增删；业务仓库仍可在自己的 CI 之外做更多检查。

## 实施计划

1. **建立中央检查套件的运行方式**：在 `tests/packs/<repo>` 中区分"测试套件"与"检查套件"（例如 `pack.json` 增加一个 `checks` 层，或新增 `tests/run-checks.mjs`），两者都由中央以固定参数在检出目录上运行。
2. **迁移阶段 1 的四个脚本**：以 `TARGET_ROOT` 为基准重写路径解析（不再依赖业务仓库的相对路径假设），移入中央；业务仓库的 npm 脚本改为调用中央入口或保留原实现但由中央 CI 不再调用。
3. **改写 `central-ci.sh`**：用中央入口替换 `npm run validate:merge` 与 `npm run validate:deploy`；`npm run check:deploy` 改为固定参数直调。
4. **迁移阶段 2、3**：同上，顺序按业务依赖与风险决定。
5. **加不变量测试**：`tests/packs/<repo>` 中加一个测试，断言被集中化的检查不再经由 PR 的 `package.json` 入口调用（沿用 AW-005 迁移步骤 2 的做法）。
6. **文档**：在 `docs/05_INTEGRATION_GUIDE.md` 记录"哪些检查由中央拥有、哪些仍由业务仓库拥有"，并说明 `check:deploy` 的 dry-run 语义仍由产品 CLI 决定。

## 风险与取舍

- **中央仓库承担业务检查逻辑**：与"业务仓库保留产品检查"的分工有张力。缓解：只在证据完整性敏感的检查上接管，其余留在业务仓库；并接受规则变更需要两处同步的成本。
- **检查逻辑分叉**：中央与业务仓库的同名脚本可能漂移。缓解：业务仓库的 npm 脚本直接调用中央入口（需要时通过 npm 依赖或 `CENTRAL_CI_AW_ROOT` 约定），避免两套实现。
- **迁移期证据缺口**：部分脚本迁移后、其余未迁移的窗口内，缺口仍然存在。缓解：按阶段推进，每个阶段单独验证。
- **失败模式变化**：中央脚本失败时的错误信息会与业务脚本不同（中央脚本的输出进入 Action Worker 的运行日志）。缓解：错误信息按 `docs/01_SHARED_GOVERNANCE.md` §2 用英文，并指明是哪个检查。

## 需 owner 决定

1. 是否启动本项目（分阶段推进，不与 AW-005 捆绑）。
2. 集中化边界的判定权：是否接受"由中央项目维护者裁定某个检查是否纳入"的模式。
3. 阶段顺序：是否从阶段 1（四个纯静态脚本）开始。
4. 阶段 3 的 `check:deploy`（产品 CLI 的 dry-run）是否值得集中，还是仅记录为已知缺口。

## 未决问题

- 中央检查套件是否复用 `tests/packs/<repo>` 的目录，还是独立成 `tests/checks/<repo>/`（前者更省事，后者边界更清楚）。
- 业务仓库的 npm 脚本如何调用中央检查：npm 依赖、git submodule，还是仅 CI 路径。
