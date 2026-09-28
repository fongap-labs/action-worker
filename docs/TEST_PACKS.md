# Test Packs

受管业务仓不再存放自己的测试套件。每个业务仓的测试由 Action Worker 以 **Test Pack** 形式持有，位于 `tests/packs/<pack>/`，在中央 CI 中针对被检出的目标仓源码执行。

## 1. 为什么集中

- **测试不能被同一个 PR 削弱。** 业务仓的 `tests/` 与 `package.json` 脚本都位于 PR 作者可修改的范围内；Pack 来自可信 ref，PR 只能被它检验，不能改写它。
- **积木复用。** `tests/kit/` 提供统一 harness、目标定位、fetch/时间/契约断言等积木，业务套件只写断言。
- **一处治理。** 用例清单、门禁分层、Runner 并行与报告都由 Action Worker 统一维护。

## 2. 目录

```text
tests/
  kit/               通用积木（harness、target、fetch、time、contract、mock-d1、python/kit_target.py）
  run-pack.mjs       Pack 运行器：node tests/run-pack.mjs <pack> <绝对 target_root> [unit|gate|all]
  packs/<pack>/      每个业务仓一个 Pack（pack.json + 套件）
  inventory/         迁移前基线清单（只增不减）
```

## 3. 执行合同

| 项 | 说明 |
|---|---|
| 测试来源 | Action Worker（可信 ref 或 `.github/test-pack.json` 固定的历史提交） |
| 被测代码 | `CENTRAL_TEST_TARGET_ROOT`（PR head 检出目录），只读、只导入 |
| JS 套件 | `import … from '#target/<path>'` 导入目标源码；`#kit/*` 导入积木 |
| Python 套件 | `from kit_target import target_root`；`PYTHONPATH` 含目标仓与 `tests/kit/python` |
| 信任域 | `sandbox`：`execute_pr_code: true`、`allow_secrets: false`（见 `policies/execution.json`） |
| 入口 | 业务仓 `central-ci.sh` 调用 `node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" <pack> "$TARGET_ROOT"` |

`central-ci-dispatch.yml` 在 Linux/Windows 作业中检出 Action Worker 到 `aw/`，并导出 `CENTRAL_CI_AW_ROOT`。

## 4. 版本固定

业务仓 `.github/test-pack.json`：

```json
{ "schema_version": 1, "pack": "ai-gateway", "ref": "main" }
```

- `ref` 只能是 `main` 或完整 commit SHA；SHA 必须是 Action Worker 可信历史的祖先（`scripts/prepare-test-pack.ts` 校验）。
- 该文件属于 **CI 控制路径**（与 `execution-manifest.json`、`central-ci.sh` 同级）：修改它需要同仓库可信维护者 PR，并按 head 自验证。
- 行为变更（`breaking` / `api` / `migration`）走配对流程：先合并 Action Worker 的 Pack 变更，再让业务 PR 固定到该提交。

## 5. 用例清单（不丢用例）

`tests/inventory/<pack>.baseline.json` 是**迁移前**在业务仓原位置运行得到的用例清单。

```bash
# 收集当前 Pack（node）
node tests/kit/inventory.mjs collect --dir tests/packs/ai-gateway --cwd <target> \
  --preload tests/kit/register-target.mjs --target <target> --out current.json
# 收集当前 Pack（python）
node tests/kit/inventory.mjs collect-python --dir tests/packs/delta \
  --config tests/packs/delta/pytest.ini --cwd <target> --target <target> --run --out current.json
# 对账：基线中的每个用例必须仍存在且通过
node tests/kit/inventory.mjs verify --baseline tests/inventory/<pack>.baseline.json --current current.json
```

合并、重命名文件不会触发失败；删除或减少用例必须显式修改基线并经审阅。

## 6. 仍留在业务仓的测试

判定规则：无法通过 `TARGET_ROOT` 从外部访问被测对象的测试才保留。

- Rust 内联 `#[cfg(test)]` 与 crate 内集成测试（依赖 crate 私有项与 Cargo 编译图）。
- 桌面端 Playwright e2e 与 vitest 组件测试（依赖 `apps/desktop` 工具链）。
- 需要 root/Docker 的基础设施脚本测试（如 `internal-vault/services/server-edge/tests/*.sh`）。
- `delta-suite/tests/foundation_runtime_e2e`（被编译进固定的 Foundation 核心 crate）。

## 7. 新增测试

1. 在 `tests/packs/<pack>/` 新增套件；JS 用 `#kit/harness.mjs`（`node:test`），Python 用 pytest。
2. 不要在套件里重复实现 `test()`、`dateAtIso()`、fetch mock，使用 `tests/kit/` 中的积木；缺少积木时先补积木。
3. 需要时间/全局状态隔离的套件保持独立文件（例如依赖真实计时的用例）。
4. 门禁层套件登记在 `pack.json` 的 `tiers.gate`；其余套件由磁盘发现，无需登记。
