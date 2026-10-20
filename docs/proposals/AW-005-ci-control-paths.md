# 提案 AW-005：拉取请求可以修改自身 CI 的哪些内容

状态：**已采纳建议**（标准工具采用方案 A，配置文件与仓库自有检查脚本采用方案 C）。已在 `ai-gateway` 中实施；它此前是唯一通过 `npm run` 调用控制脚本的仓库（PR "run biome and tsc from the central script with fixed arguments"）。将仓库自有检查脚本集中化仍是一个单独的项目（提案 AW-007）。

## 现状

- `scripts/resolve-ci-control-ref.ts` 决定中央 CI 脚本从哪个引用读取。`CONTROL_PATHS` 包含四个文件：`.github/execution-manifest.json`、`.github/scripts/central-ci.sh`、`.github/scripts/central-ci.ps1`、`.github/test-pack.json`。如果 PR 没有修改其中任何一个，CI 控制文件来自 **base** 分支；如果修改了其中之一，则使用 PR head，但仅限来自同一仓库且身份为 `OWNER`/`MEMBER`/`COLLABORATOR` 的 PR；其他情况一律拒绝。
- 因此，控制脚本是可信的，但它所运行的内容并不可信：它执行的命令由 PR 自身的文件定义。当前仓库中的示例：`ai-gateway` 运行 `npm run validate:merge` 与 `npm run check:deploy`（在 PR 的 `package.json` 中定义）；`internal-vault` 运行 `python -m ruff check .`（由 PR 的 `ruff.toml` 配置）；`delta-suite` 运行 `ruff check advanced scripts --select ...`（标志固定在脚本中，因此没有问题）；`delta` 与 `app-source` 以固定标志调用 `cargo`（PR 的 `Cargo.toml` 与 lint 属性仍然生效）。
- 代码在沙箱中运行，不接触中央密钥，因此这不是密钥泄露问题。它是一个**证据完整性**问题：PR 可以削弱自身的检查（把 `validate:merge` 脚本改为 `exit 0`，放宽 `ruff.toml`），却仍然产生 `validate-merge=success`。
- 测试集中存放在中央测试包（`tests/packs/<repo>`）之后，测试本身的这一问题已经封闭。

## 方案

| | 思路 | 解决的缺口 | 成本 |
|---|---|---|---|
| A | 控制脚本（base 引用，可信）以固定参数直接调用标准工具，而不是 `npm run <script>` | 对于被迁移的命令有效。工具配置文件（`biome.jsonc`、`ruff.toml`、`tsconfig.json`）仍然由 PR 控制。在 `ai-gateway` 中，`validate:merge` 主要运行**仓库自有脚本**（`scripts/check-syntax.mjs`、`secret-scan.mjs`、`docs-check.mjs`、`link-check.mjs`、`deployment-config-check.mjs`、`migrations-check.mjs`、`test.mjs`），只有 `biome` 与 `tsc` 是标准工具，因此单独实施 A 在那里几乎没有效果 | 每个仓库的 `central-ci.sh` 需修改一处；保持脚本与包脚本同步 |
| B | 把定义检查的文件加入 `CONTROL_PATHS`：`package.json`、`package-lock.json`、lint 与类型检查配置、`Cargo.toml` 的 lint 表、`ruff.toml` | 这些文件的变更成为"控制变更"，只接受来自可信的同仓库维护者的 PR | **对 Dependabot 的影响**：Dependabot 的 PR 作者关联为 `CONTRIBUTOR`，不可信，并且总是修改 `package.json` / 锁文件。它们会被拒绝，并提示 `CI control changes require a trusted same-repository maintainer PR`。维护者的锁文件升级也会每次都切换到 head 引用的 CI |
| C | 保持现状，并记录 PR 控制的脚本与配置可以削弱检查 | 无 | 无；依赖人工评审，以及 `package.json` / 配置文件上的 `CODEOWNERS` |

## 建议

**标准工具（`biome`、`tsc`、`ruff`、`cargo`）采用 A；配置文件与仓库自有检查脚本采用 C；并依靠 CODEOWNERS 进行评审**（已在 ORG-009 的 PR 中完成：ai-gateway #78、external-vault #49、internal-vault #53、app-source #43）。要真正关闭 `ai-gateway` 的缺口，需要把它的检查脚本迁移到中央拥有的代码中（例如 `tests/packs/ai-gateway` 或在检出目录上运行的 Action Worker 脚本）；这是一个较大的项目，建议单独立项，而不要与本提案捆绑。不要对 `package.json` 与锁文件采用 B：这会破坏 Dependabot 的流程，并为每次依赖更新增加摩擦。如果以后需要 B，应仅适用于 lint / 类型检查配置，依赖清单保持在范围之外；这需要单独的决定。

采纳后的迁移步骤：

1. 在 `central-ci.sh` 调用 `npm run <script>` 的每个仓库中（目前只有 `ai-gateway`），把对标准工具的调用替换为直接命令与固定标志（`npx biome check .`、`npx tsc --noEmit`）；开发者仍保留 npm 脚本。仓库自有脚本保持不变，直到上述单独的项目完成。
2. 在 `tests/packs/<repo>` 中添加一个测试：如果 `central-ci.sh` 调用了 `npm run`，则测试失败。
3. 在 `docs/05_INTEGRATION_GUIDE.md` 中记录：控制脚本不得执行 PR 控制的文件中定义的命令，以及哪些配置文件仍由 PR 控制。

## 影响

- 方案 A 或 C 对 Dependabot 流程没有影响。
- 在所调查的仓库中，只有 `ai-gateway` 的控制脚本调用了 `npm run`；其他仓库已经直接调用工具，因此 A 仅涉及一个仓库加上测试包测试。该 PR 修改了一个控制文件，因此它的 CI 从其 head 引用运行，并且需要可信的同仓库作者。
- 诚实的限制：实施 A 之后，`ai-gateway` 仍会从 PR 运行其自有的检查脚本；那里的缺口只能由单独的集中化项目关闭。
- 任何方案都无法覆盖：PR 修改 `ruff.toml` 或 `tsconfig.json` 以放宽某条规则。在这种情况下，评审者（CODEOWNERS）就是控制手段。
