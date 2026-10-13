# 提案 AW-002：使用 GitHub Environments 隔离部署与任务密钥

状态：**部署路径已实施**（PR "let the control plane decide deploy environments and secret ceilings"：中央环境与密钥策略、只读检出令牌、为使用管理员令牌的作业设置 `admin-ops`）。**任务路径保持现状（方案 A）**；方案 B 与 C 在部署演练之后仍可选用。**仍需 owner 手动完成：** 一次演练部署、将 `AW_DEPLOY_SECRET_POLICY_MODE` 切换为 `enforce`、把密钥复制到各环境，然后删除仓库级副本。

## 现状

- `deploy-source-script.yml` 的 `deploy` 作业已声明 `environment: ${{ needs.prepare.outputs.environment }}`，但该值读取自**被部署的目标仓库**的 `deploy.json`（被部署的一方自行声明环境）。运行目标代码的步骤使用 `env: ${{ secrets }}`：每个仓库级密钥（以及环境级密钥）都被放入该步骤的环境，随后目标未声明的名称被 `unset`。
- `handle-task-dispatch.yml`（`execute` 作业）同样使用 `env: ${{ secrets }}` 与任务源的允许列表；自 PR #410 起，一个中央上限（`policies/task-secrets.json`，`AW_TASK_SECRET_POLICY_MODE=warn|enforce`）只能减少任务源声明的内容。任务作业**没有** `environment:`。
- `unset` 只是从进程环境中移除名称；它无法阻止同一作业中已运行的代码读取 Runner 内存，而且允许列表由被执行的一方声明。
- `fongap-labs/action-worker` 中已存在 `production` 与 `admin-ops` 环境，部署分支策略为仅 main。仓库级密钥仍保留。
- 在部署路径中，`resolve-secret-scope.ts` 的第 4 个参数（拒绝名称列表）未被传入，因此只应用目标声明的允许列表与内置保留前缀。

## 目标

由中央仓库（而非被部署的仓库）决定某个仓库可以使用哪个环境，以及哪些密钥名称可以进入该环境；密钥从仓库级迁移到环境级，使未绑定环境的作业根本无法读取它们。

## 设计

1. **环境权威**（`policies/deploy-environments.json`）：`{ "<owner/repo>": ["production", ...] }`。`validate-deploy-source.ts` 在解析 manifest 之后检查声明的 `environment` 是否属于该仓库的集合；否则部署失败即关闭。未列入该文件的仓库无法部署。
2. **中央密钥列表**（`policies/deploy-secrets.json`）：`{ "<owner/repo>": { "<environment>": ["NAME", ...] } }`。有效允许列表是目标的 `deploy.secrets.allowed` 与该列表的**交集**；不在中央列表中的目标名称会导致失败（而不是被静默丢弃），与 `enforce` 模式下的任务上限一致。保留前缀仍被拒绝（`AW_`、`GITHUB_`、`RUNNER_`、`ACTIONS_`、`NODE_OPTIONS`、`GH_TOKEN`），并作为第 4 个（拒绝）参数传入。
3. **分支限制**：环境保留"仅 main"的部署分支策略。部署作业运行在本仓库的 `main` 上（该工作流由 `repository_dispatch` 分发，而 `repository_dispatch` 始终使用默认分支），因此 PR 分支无法获得环境密钥。除在下方演练中验证外，无需为此修改工作流。
4. **检出令牌**：`Checkout deploy source` 不再使用 `AW_CONTROL_TOKEN`，改用只读的 `AW_CHECKOUT_TOKEN`（已在 PR #411 中为 CI 作业引入），若目标为公开仓库则使用 `github.token`。PR #411 的不变量测试被扩展，使 `deploy` 作业不得引用 `AW_CONTROL_TOKEN` 或 `AW_ADMIN_TOKEN`。
5. **管理员令牌作业**：每个使用 `AW_ADMIN_TOKEN` 的作业都必须同时声明 `environment: admin-ops`；否则将该密钥迁移到环境中会使其失效。这是原计划的一个缺口。受影响的工作流列表由一个测试生成，该测试在作业引用 `secrets.AW_ADMIN_TOKEN` 却没有 `environment:` 时失败。
6. **任务路径**（`handle-task-dispatch.yml`）——三种选择：
   - A. 目前只做部署路径；任务继续使用仓库级密钥，并强制执行中央上限。风险最低，但任务的主要弱点仍然存在。
   - B. 为每个任务源仓库添加 `environment: tasks-<repo>`。作业的 `environment:` 可以是表达式，因此一个作业可以服务所有仓库，但每个仓库都需要自己的环境及其密钥副本；同一仓库的不同项目之间的密钥无法通过环境隔离，只能通过中央上限隔离。
   - C. 对于有真实密钥的仓库（ai-gateway、internal-vault）采用 B，其余采用 A。
   - **建议：现在采用 A，部署演练成功之后再采用 B/C。** 在使用方声明环境之前，任务密钥不能从仓库级移除。
7. **过渡与回滚**：演练通过之前，仓库级密钥保持不变。回滚即撤销该 PR；只要仓库级密钥存在，旧行为就仍然可用。

## 影响与风险

- ai-gateway（37 个名称，环境 `production`）与 internal-vault（3 个名称，`server-edge-cloud-edge`）的每一次部署，都依赖两份新策略文件是否完整；缺少某个名称会导致部署失败，这是有意为之。
- GitHub Free：环境密钥与部署分支策略适用于公开仓库；Free 套餐的私有仓库能否使用环境保护规则**未经验证**（本次会话无法获取文档）。部署环境位于公开的 `action-worker` 仓库中，因此这不构成阻碍，但私有仓库上的必需审批人将无法使用。
- `repository_dispatch` 作业始终运行在默认分支上，因此"仅 main"在构造上已满足；策略仍然会约束从其他分支手动发起的 `workflow_dispatch` 运行。

## 计划约束（owner，2026-10-07）

组织保持在 Free 套餐，私有仓库保持私有。本设计不受影响：环境（`production`、`admin-ops` 以及任何 `tasks-<repo>`）属于**公开**的 `action-worker` 仓库，在 Free 套餐下该仓库可以使用环境密钥与仅 main 的部署分支策略。私有仓库只作为部署与任务的*源*出现；不需要在其中做任何配置。

## Owner 手动步骤

1. 批准或修改本设计（尤其是第 6 项）。
2. 实施合并后：在环境中创建同名密钥（P-00 C2），对 ai-gateway 执行一次 `workflow_dispatch` 部署作为健康检查演练，然后才删除仓库级副本（P-00 C3）。我不会删除任何密钥。
3. 确认所有目标仓库的 `AW_CHECKOUT_TOKEN` 均为只读（Contents: read）。

## 批准后的实施计划（第二阶段）

新增策略文件与校验器，并附带测试；在 `validate-deploy-source.ts` 中加入环境检查；接通拒绝名称参数；替换检出令牌；扩展不变量测试；更新文档与 CHANGELOG。验收标准：`npm run check` 通过，并新增"未授权环境失败"与"目标声明超出中央列表则失败"两项测试。
