# 测试包

Action Worker 持有每个受管业务仓库的测试，形式为 `tests/packs/<pack>/` 下的 **测试包（test pack）**。中央 CI 针对目标仓库检出的源码运行该测试包。只有无法从仓库外部运行的测试，才留在业务仓库中（见第 6 节）。

## 1. 为什么测试集中管理

- **PR 不能削弱自己的测试。** 业务仓库的 `tests/` 与 `package.json` 脚本在 PR 作者的可控范围内；测试包来自可信引用，因此 PR 只能被它检查，而不能改写它。
- **可复用的构建模块。** `tests/kit/` 提供共享的 harness、目标查找、fetch / 时间 / 合同断言等构建模块，因此业务测试套件只需编写断言。
- **集中治理。** 测试清单、门禁层级、Runner 并行度与报告，都由 Action Worker 维护。

## 2. 目录结构

```text
tests/
  kit/               共享构建模块（harness、target、fetch、time、contract、mock-d1、python/kit_target.py）
  run-pack.mjs       测试包运行器：node tests/run-pack.mjs <pack> <绝对路径的 target_root> [unit|gate|all]
  packs/<pack>/      每个业务仓库一个测试包（pack.json + 测试套件）
  inventory/         迁移前的基线清单（只能增长）
```

## 3. 执行合同

| 项目 | 说明 |
|---|---|
| 测试来源 | Action Worker（可信引用，或由 `.github/test-pack.json` 固定的历史提交） |
| 被测代码 | `CENTRAL_TEST_TARGET_ROOT`（PR head 的检出目录），只读，仅用于导入 |
| JS 套件 | `import … from '#target/<path>'` 导入目标源码；`#kit/*` 导入构建模块 |
| Python 套件 | `from kit_target import target_root`；`PYTHONPATH` 同时包含目标仓库与 `tests/kit/python` |
| 信任域 | `sandbox`：`execute_pr_code: true`，`allow_secrets: false`（见 `policies/execution.json`） |
| 入口 | 业务仓库的 `central-ci.sh` 调用 `node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" <pack> "$TARGET_ROOT"` |

`central-ci-sandbox.yml` 在 Linux 与 Windows 作业中将 Action Worker 检出到 `aw/`，并导出 `CENTRAL_CI_AW_ROOT`。

## 4. 版本固定

业务仓库的 `.github/test-pack.json`：

```json
{ "schema_version": 1, "pack": "ai-gateway", "ref": "main" }
```

- `ref` 只能是 `main` 或完整的提交 SHA；SHA 必须是 Action Worker 可信历史中的祖先提交（由 `scripts/prepare-test-pack.ts` 检查）。
- 该文件是 **CI 控制路径**（与 `execution-manifest.json`、`central-ci.sh` 相同）：修改它需要来自同一仓库、可信维护者的 PR，并且该 PR 会针对其自身的 head 进行验证。
- 行为变更（`breaking` / `api` / `migration`）采用成对流程：先在 Action Worker 中合并测试包的变更，再把业务 PR 固定到该提交。

## 5. 测试清单（不丢失任何测试）

`tests/inventory/<pack>.baseline.json` 是在迁移之前，通过在业务仓库的原始位置运行测试套件而收集到的测试用例清单。

```bash
# 收集当前测试包（node）
node tests/kit/inventory.mjs collect --dir tests/packs/ai-gateway --cwd <target> \
  --preload tests/kit/register-target.mjs --target <target> --out current.json
# 收集当前测试包（python）
node tests/kit/inventory.mjs collect-python --dir tests/packs/delta \
  --config tests/packs/delta/pytest.ini --cwd <target> --target <target> --run --out current.json
# 对账：基线中的每个用例都必须仍然存在并通过
node tests/kit/inventory.mjs verify --baseline tests/inventory/<pack>.baseline.json --current current.json
```

合并或重命名文件不会导致失败；删除或减少测试用例，则需要一次明确的、经过评审的基线变更。

## 6. 留在业务仓库中的测试

规则：只有当测试无法通过 `TARGET_ROOT` 从外部触及被测对象时，它才留在业务仓库中。

- Rust 的内联 `#[cfg(test)]` 测试，以及 crate 内部的集成测试（它们依赖 crate 私有项与 Cargo 构建图）。
- 桌面端的 Playwright e2e 与 vitest 组件测试（它们依赖 `apps/desktop` 工具链）。
- 需要 root 或 Docker 的基础设施脚本测试（例如 `internal-vault/projects/server-edge/tests/*.sh`）。
- 编译进固定版本核心 crate 的运行时端到端测试（`delta-suite/tests/foundation_runtime_e2e`）。
- Rust crate 的集成测试与模糊测试（`app-source/projects/SecurePigeon/crates/*/tests`）。

## 7. 添加测试

1. 将套件添加到 `tests/packs/<pack>/`；JS 使用 `#kit/harness.mjs`（`node:test`），Python 使用 pytest。
2. 不要在套件中重新实现 `test()`、`dateAtIso()` 或 fetch mock；应使用 `tests/kit/` 中的构建模块，缺少所需模块时先在该目录中添加。
3. 需要时间或全局状态隔离的套件，放在独立文件中（例如依赖真实计时的用例）。
4. 门禁层级的套件在 `pack.json` 的 `tiers.gate` 下注册；其余套件从磁盘自动发现，无需注册。

## 8. 各仓库状态

| 仓库 | 测试包 | 留在业务仓库中的测试 |
|---|---|---|
| ai-gateway | `ai-gateway`（24 个模块） | 无 |
| delta | `delta`（6 个模块） | Rust 内联与 crate 测试、`apps/desktop` 的 e2e 与 vitest、3 个小包（如 `packages/delta_worker_sdk`）内的测试 |
| delta-suite | `delta-suite`（4 个模块） | 编译进固定版本核心的运行时 e2e 测试（`tests/foundation_runtime_e2e`） |
| internal-vault | `internal-vault`（8 个模块） | 基础设施 shell 测试（`projects/server-edge/tests/*.sh`，需要 root 与 Docker） |
| app-source | `app-source`（1 个模块，license-service 的数据库测试） | Rust crate 测试（`crates/*/tests`）；`legacy/test_*.py` 是 CI 从不运行的遗留脚本，不属于测试包 |
| external-vault | 无 | 无测试套件；CI 只运行 manifest 与 secret scan 检查脚本 |
| AssHub | 无 | 空仓库 |
