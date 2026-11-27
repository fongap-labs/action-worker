# 开发指南

本文件定义 Action Worker 与受管业务仓库共用的开发流程。机器边界由合同、策略、规则与治理文档确定。

## 1. 开始之前

先做以下判断：

1. 这是项目实现，还是通用的治理 / 执行能力；
2. 是否已有可复用的合同、策略、执行器或 skill；
3. 变更是否涉及信任、密钥、Runner、门禁、发布或部署边界；
4. 合同测试与文档是否需要同步修改。

原则：

> 项目实现留在业务仓库；治理、授权与重型执行进入 Action Worker。

公开仓库与私有仓库遵循相同的规则。

## 2. 中央工作器 负责的内容

Action Worker 负责：

- PR 治理、CI Evidence 与 AI Review；
- CI / 测试 / 构建执行；
- 任务与定时执行；
- Runner 解析与门禁；
- Source Policy；
- Release 的构建、治理与发布；
- Deploy 的治理与执行；
- 产物与 provenance（来源证明）；
- 通用的状态写回与输入输出合同。

## 3. 业务仓库负责的内容

业务仓库保留：

- 产品代码；
- 无法从仓库外部运行的项目测试（见 [TEST_PACKS.md](TEST_PACKS.md) 第 6 节）；
- 构建 / 打包 / 部署脚本；
- 项目架构与协议；
- 执行清单；
- 平台专属的工具链声明；
- 最薄的分发入口；
- GitHub 平台确实需要时的一个极薄的检查桥接。

业务仓库不得保留第二套中央治理，也不得为了自身方便而长期运行重型的 CI / 构建 / 审查 / 发布 / 部署。

## 4. 开发流程

```text
检查
→ 定义合同
→ 实现
→ 测试
→ PR
→ Security Gate
→ Central CI
→ Governance / validate-merge
├→ 合并
└→ AI Review（门禁之后，仅供参考）

合并
→ Main Write Guard
→ 可信的 main SHA
```

当边界发生变化时，先修改合同、策略或回归测试，再修改实现。

### 本地预检（不替代中央门禁）

在 Action Worker 仓库中使用中央版本目录指定的 Node.js，执行一次 `npm ci`，然后：

- `npm run preflight`：快速执行 TypeScript 类型检查、Biome 和关键环境/发布契约测试。
- `npm run preflight -- full`：执行完整本地单测、格式检查与 Python 源码命名回归。

这是零新增依赖的本地检查入口，不强制安装 Git Hook、Docker 或 act，也不运行需要 GitHub App、远程权限、签名密钥、受保护 Runner 或真实生产环境的检查。`validate-merge`、Security Gate、CI Evidence 和 Main Write Guard 始终以 GitHub 执行结果为准。

### 共用工具链版本计划

中央 Linux 和 Windows 沙箱从受信任的 Action Worker 提交读取
`policies/dependency-versions.json`，不读取候选 PR 自带的中央策略。
Node.js 统一使用中央目录的精确版本，不再按仓库区分，不再保留旧沙箱版本回退。
项目根目录 `.node-version` 等声明仍纳入盘点，但不能覆盖中央安装版本。
声明 `packageManager` 使用 pnpm 的项目由中央目录指定安装版本。
缓存键使用实际选择的工具链版本，不从候选代码接收安装命令。

Windows 11 或其他本机环境在 Action Worker 检出目录中运行：

```powershell
node scripts/resolve-runtime-versions.mjs
node scripts/resolve-runtime-versions.mjs ../plugins
```

两条均使用同一中央工具链版本，第二条额外判断项目是否需要 pnpm。
从当前受信任分支检出项目后再生成计划；所有智能体共享同一份输出，不各自维护版本。
该入口只需已安装的 Node.js，不安装工具、不修改 PATH、不升级依赖。
中央调度、私有仓库持续集成及发布构建的 Node.js 安装同样读取该目录；发布清单的版本文件仅用于判断是否需要 Node.js，不覆盖实际安装版本。开发分支的中央自检读取当前可信控制版本，不从另一受管分支复制源码。Windows 11 本机安装与启用见下节。

### Windows 11 统一工具链安装

在可信 Action Worker 检出目录中打开 PowerShell（普通用户，无需提升权限），默认先生成计划，不下载或修改环境：

```powershell
.\scripts\install-windows-toolchain.ps1
.\scripts\install-windows-toolchain.ps1 -Mode Install -Root 'D:\FongapLabs\toolchain'
.\scripts\install-windows-toolchain.ps1 -Mode Activate -Root 'D:\FongapLabs\toolchain'
```

不指定目录时使用当前用户的本地应用数据目录下的 `FongapLabs\toolchain`。
安装和启用模式支持 Windows x64、ARM64；Python 安装包是否存在由 Windows Package Manager 决定。
Node.js 使用中央精确版本的官方便携包并检查官方 SHA-256 清单；
pnpm 使用中央精确版本的独立目录，禁止安装生命周期脚本。
Python 优先复用符合中央版本系列且具备 pip、venv 的现有解释器，否则使用 WinGet 的 Python 用户级安装包，
保留标准库和开发头文件，关闭 IDLE、Tk、文档、测试、调试组件、快捷方式、文件关联及启动器。
中央尚未固定 Python 补丁版本，因此复用或安装的是相应系列，不承诺最新安全补丁或特定补丁版本。

安装通过实际版本验证后，才为当前 PowerShell 会话设置共用 PATH。
用此会话启动各 Agent，避免其独立配置不同的工具路径；新会话可直接使用启用模式。
显式增加 `-PersistPath` 才更新当前用户 PATH 和 pnpm 版本不匹配策略，不修改系统 PATH 或 PowerShell 配置文件。
若机器级 PATH、Agent 自带工具或项目配置覆盖该环境，仍需调整 Agent 启动方式或项目声明；
用户级 PATH 不保证优先于机器级 PATH。pnpm 版本不匹配应报告问题而非自动下载，存量项目声明仍待整改。
没有中央版本基准的 Git、Rust、uv 等不会自动安装。各项目的依赖、虚拟环境、锁文件继续独立管理。
已存在的管理目录不会自动覆盖或删除，版本不符时明确失败；安装失败可能留下已成功安装的工具，修复后可重试。
此脚本不运行目标仓库安装命令，不获取 GitHub 凭据，也不修改任何远端仓库。

### 业务仓库通用本地预检（无复制脚本）

在本地拥有 `action-worker` 和任一业务仓库的检出目录时，从 Action Worker 运行：

```bash
npm run preflight:business -- ../dsh-plugin quick
npm run preflight:business -- ../dsh-plugin full
```

工具读取业务仓库已有的 `.github/release.manifest.json`、`projects/*/release.manifest.json`、`deploy.json`，校验 Release Manifest 合同、Runner Profile 和本地构建/验收脚本路径。不运行部署。

业务仓库可选声明 `.github/preflight.json`，不必复制脚本：

```json
{ "schema_version": 1, "checks": [
  { "id": "unit", "command": "npm", "args": ["test"], "mode": "quick" },
  { "id": "types", "command": "npm", "args": ["run", "typecheck"], "mode": "full" }
] }
```

`quick` 运行契约及快速声明检查，`full` 还执行完整声明检查。只能调用 npm/pnpm/node/python/python3/cargo，不通过 shell 拼接命令；命令在本机以当前用户权限执行，勿对不可信代码运行。`action-worker` 需先执行 `npm ci`。此工具无法代替 GitHub App 权限、远程 Runner、真实签名与中央 `validate-merge`。

中央 CI 的 `Public downstream compatibility` 在 Runner 政策、发布/部署合同解析器变化时，读取 `fongap-labs` 的**公开仓库**默认分支清单并进行新旧 Runner 兼容性对比。该步骤不借用高权限 GitHub App Token；私有仓库不会被误报为已扫描。发现新回归即阻止中央 PR 合并。

私有仓库由受保护 `main` 上现有的 `enroll-organization-repositories.yml`（组织仓库接入）在定时检查和相关代码推送时使用**只读** GitHub App 安装令牌自动盘点。仅验证已安装、未归档私有仓库的发布/部署清单、Runner Profile 和受信任域，并在公开 Actions 日志只公布汇总数量与匿名故障指纹。出于凭据隔离，该扫描不在不可信 PR 上使用私有令牌；其结果是合并后的独立审计，不能冒充 PR 阶段对私有仓库的预合并兼容保证。
## 5. 持续集成

能够从仓库外部运行的测试，保存在 Action Worker 的测试包中（[TEST_PACKS.md](TEST_PACKS.md)）；其余测试保留在业务仓库中。所有测试默认都在 Action Worker 的沙箱中运行。

```text
仓库事件
→ 薄分发
→ Action Worker
→ 检出不可变源码
→ 项目测试 / 构建
→ CI Evidence
```

如果 GitHub 平台要求目标仓库自行创建必需检查，可以保留一个极薄的 `validate-merge` 桥接。该桥接不运行任何产品测试，只负责连接中央的 `CI Evidence` 与 `PR Governance`。

## 6. 运行器

项目代码不得绑定具体的 Runner 基础设施。项目只声明 `runner_profile`；Action Worker 的 Runner 策略负责解析为实际的 GitHub 托管或 self-hosted 后端。

新增 self-hosted Runner 不得要求修改业务仓库。详细规则见 [RUNNER_POLICY.md](RUNNER_POLICY.md)。

## 7. 工作流变更

工作流变更至少检查以下内容：

- 权限是否最小化；
- 密钥是否可能到达不可信的执行域；
- 触发器是否可能被 fork 或 PR 输入滥用；
- 并发是否正确；
- 源 SHA 是否不可变；
- Runner 是否由中央策略选择；
- 产物与证据是否绑定到源 SHA。

此外还要通过确定性的 Security Gate、actionlint、合同测试，以及在需要时的 ShellCheck。

工作流文件名遵循 [03_NAMING_CONVENTIONS.md](03_NAMING_CONVENTIONS.md) §8 的规则；`tests/workflow-naming.test.ts` 会对其进行检查。

Security Gate 独立于 AI Review，至少阻止以下内容：新增的高置信度凭据、敏感密钥文件、`toJSON(secrets)`、`pull_request_target`、`permissions: write-all`，以及未固定到提交 SHA 的外部 action。

控制逻辑优先使用 TypeScript 编写。Shell 只能作为简短的 Runner 胶水代码，或明确的外部引导边界。

## 8. 人工智能 与门禁

AI 负责审查、建议与发现问题；它既不决定权限边界，也不决定合并门禁。AI Review 在确定性 PR 门禁结论之后运行，无论严重程度如何，每个 AI 发现都只是仅供参考的证据。AI Review 超时、模型不可用或审查引擎故障，既不能改变门禁，也不能延迟门禁的结论。

门禁只信任确定性策略、Security Gate、CI Evidence、PR Policy、Release / Deploy Policy、当前的 GitHub 事实以及执行 provenance。

Agent 不得通过重新运行、更换模型、更换 Runner 或调整任何审查参数来改变确定性门禁。

## 9. 主分支来源审计

每个进入正式 Release 或 Deploy 的源 SHA，都必须先通过 Main Write Guard。名为 `main` 的分支本身不构成可信来源的证明。

直接 push、未知写入，或无法关联到已通过门禁的已合并 PR 的 SHA，都失败即关闭。

## 10. 发布与部署

业务仓库负责项目脚本；Action Worker 负责中央执行、凭据与治理。

```text
Release：不可变源码 → 中央构建 / 打包 → 产物 + provenance → Release Governance → 发布 / 验证 / 回滚
Deploy： 不可变源码 → 中央源门禁 → 项目部署脚本 → Runner 解析 → 受控部署 → 健康检查 / 回滚
```

## 11. 完成定义

在结束一项任务之前，确认：

- 没有新增按仓库名或项目名划分的分支；
- 没有在业务仓库中新增重型执行；
- 没有把 Runner 基础设施写入项目合同；
- 不存在第二个密钥、门禁或发布权威；
- 合同测试覆盖了新边界；
- 文档区分了"当前实现"与"目标边界"；
- 旧的入口已被删除，或已明确列入迁移清单；
- 新增或修改的文档，没有项目背景的人也能读懂（见 [01_SHARED_GOVERNANCE.md](01_SHARED_GOVERNANCE.md) §2）。
