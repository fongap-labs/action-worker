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

## 5. 测试清单

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
| mcp-hub | `mcp-hub`（12 个中央模块、48 个回归用例，实时 TAP 基线持续执行） | 第五批已完成双跑与重复清理，仍有 11 个本地模块、保留必要的 Access 辅助文件 |
| delta | `delta`（6 个模块） | Rust 内联与 crate 测试、`apps/desktop` 的 e2e 与 vitest、3 个小包（如 `packages/delta_worker_sdk`）内的测试 |
| delta-suite | `delta-suite`（4 个模块） | 编译进固定版本核心的运行时 e2e 测试（`tests/foundation_runtime_e2e`） |
| internal-vault | `internal-vault`（8 个模块） | 基础设施 shell 测试（`projects/server-edge/tests/*.sh`，需要 root 与 Docker） |
| app-source | `app-source`（1 个模块，license-service 的数据库测试） | Rust crate 测试（`crates/*/tests`）；`legacy/test_*.py` 是 CI 从不运行的遗留脚本，不属于测试包 |
| external-vault | 无 | 无测试套件；CI 只运行 manifest 与 secret scan 检查脚本 |
| AssHub | 无 | 空仓库 |

## 9. 新增测试的中央归属门禁

`policies/engineering-ownership.json` 是新增测试与工程入口的唯一中央策略。
`scripts/engineering-gate-api.ts` 与 `scripts/central-engineering-gate.ts`
在中央控制面及 Linux 沙箱检查提交增量：禁止
新增项目本地测试、项目级 CI 脚本和未经中央模板确认的工作流。仅策略明确的
不可外置路径可以新增本地测试。旧测试的修改仅作为迁移过渡期兼容，不应被
理解为新建本地测试的许可。新业务仓库应先创建中央测试包及基线，再接入
真实中央 CI；不得为了通过门禁而增加空测试或绕过差异检查。

## 10. 中央测试迁移第一阶段

先将 Runner 协议与 Runtime/Runner 凭据隔离的 8 个原始用例移至可信
`tests/packs/mcp-hub/`。中央沙箱通过可信 `pack.json` 的 `overlay: true`
自动运行测试包；原有 `npm run validate` 不变，迁移期间两套用例均运行。
Node runtime flags 由中央白名单校验，拒绝业务仓库输入任意 Node 参数。

退出 overlay 阶段的前置条件：真实 mcp-hub PR 通过完整中央 CI；获取
原始运行时用例清单并与中心测试包核对；迁移剩余用例并验证无缺失；
最后以经中央批准的可信构建入口替代业务仓库现有的构建与测试执行脚本。
未经上述验证，不删除本地原测试、helper、锁文件或项目编译配置。

### 第二批迁移验收要求

Claude Code 执行器和 Git 工作树模块的 11 个原始用例不改断言，仅将
源码导入路径转换为可信测试包的 `#target/` 导入方式。先更新 Action Worker
测试包，再将 MCP Hub 的 `.github/test-pack.json` 固定到合并后的中央提交。
通过真实中央 CI 完成 Linux、Windows、安全与证据签发，核对文件和用例完整性后，
才允许从 MCP Hub 移除重复测试文件。不可提前删除原仓库中的测试及执行配置。

### 第三批迁移验收要求

`security.test.js`（8 个用例）与 `crypto-readiness.test.js`（4 个用例）
通过中央可信测试包执行。迁移保持原断言与用例名称不变；仅将源码、测试
辅助模块导入定位到被测提交，并将数据库迁移文件读取定位到
`CENTRAL_TEST_TARGET_ROOT/migrations`。不使用业务 PR 可控路径加载新的中央测试代码。

必须先在 Action Worker 合并中央测试包，随后由 MCP Hub 的独立 PR 固定
可信提交并通过 Linux 原测试、中央 overlay 测试、Windows 和安全证据签发。
在真实双跑验收前，不得删除 MCP Hub 本地对应测试。

### 第四批迁移：访问身份认证与品牌合同

已将 `access-browser.test.js`（2 个用例）、`access-native.test.js`（3 个用例）、
`branding.test.js`（3 个用例）复制为可信中央门禁测试。三组测试保持原有断言及名称，
通过 `#target/src/` 和 `#target/tests/helpers/access.js` 使用当前被测提交的
源码和签名测试辅助模块；`access-native` 中两个虚构邮箱改为运行时拼接，
不改变测试身份值和对应断言，避免隐私扫描误报。

先合并 Action Worker 中央测试包，再由 MCP Hub 独立 PR 固定提交。
验证剩余 17 个本地测试、9 个中央模块，以及 Linux/安全与 CI 证据签发全部通过后，
才能移除上述 3 个本地重复测试文件。辅助模块 `tests/helpers/access.js`
还被其他未迁移测试使用，未核实依赖解除前不得删除。

### 已迁移用例的实时基线门禁

可信 `tests/inventory/mcp-hub.baseline.json` 固定了第四批迁移完成后的
9 个模块及 39 个测试用例名称与出现次数。由于早期迁移没有在开始前自动保存
原始 TAP 清单，该文件根据保留的迁移测试源码和真实双跑成功证据重建，
不宣称是最初仓库的历史运行时采集文件。

现在 `pack.json` 声明该可信清单。中央 overlay 执行 Node TAP 报告后，
`tests/kit/verify-tap-inventory.mjs` 对本次实际运行的测试名称、次数、
测试总数及失败状态逐项核对。缺失原用例、伪造绿灯式的空报告、
测试执行数量不足或报告失败都必须让 CI 失败，不能通过删除或重命名测试降低门禁。
基线只能在 Action Worker 中按受信评审流程修订，业务仓库 PR 不能修改它。

### 第五批迁移：多因素认证、管理权限与授权刷新

可信中央测试包新增 `cloudflare-mfa`（2 个用例）、`scoped-service-admin`
（2 个用例）及 `refresh`（5 个用例）。保持全部断言、用例名称不变，
仅将测试导入定位到 `#target/`，数据库迁移文件定位到
`CENTRAL_TEST_TARGET_ROOT/migrations`，并将 9 个名称与次数加入可信运行时基线。

必须先合并 Action Worker 中央测试包，再由 MCP Hub 固定不可变提交完成
本地 14 个模块与中央 12 个模块的真实双跑及用例基线验证；
只有 Linux、Security、CI Evidence、PR Governance 全部通过后，
才可在单独的 PR 中删除 3 个重复业务测试模块。其他本地测试、
`tests/helpers/access.js`、编译配置、部署与发布流程保持不变。

### 第五批验收结论

- `action-worker#1838` 已合并中央 3 个测试模块与 9 个用例，并将可信基线扩展为 48 个用例。
- `mcp-hub#108` 固定中央提交 `bf0778b9159eac464d8516ec7753217aa25f16a5`，完成源仓库与中央测试双跑及实时 TAP 基线核验。
- `mcp-hub#109` 完成删除后验证与中央签名门禁，删除 3 份重复测试。当前为 12 个中央测试模块、11 个本地测试模块。
- `tests/helpers/access.js` 仍由其他本地测试依赖，不属于本次清理范围；构建、发布和部署配置未改变。

下一阶段候选为客户端删除、授权任务接入和 Runner 注册/派发等仍在本地的合同测试，
遵循先中央新增、再真实双跑、最后清理重复文件的顺序，不允许以减少测试来满足治理。
