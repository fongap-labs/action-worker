# 提案 ORG-006：加固 main 分支的 ruleset

状态：**已采纳第一阶段**（四个公开仓库启用严格的状态检查；PR "require pull requests to be up to date before merging"）。第二阶段（一人审批与绕过主体）和第三阶段（GitHub App）尚未启动，需要 owner 决定。

## 现状

`policies/rulesets.json` 为每个受管仓库定义了 "Protect Main Branch"：禁止删除、禁止非快进更新、线性历史、仅允许 squash 合并、审查线程必须解决，并要求状态检查 `validate-merge`。与本提案相关的具体内容：

- `required_approving_review_count: 0`、`require_code_owner_review: false`、`require_last_push_approval: false`、`dismiss_stale_reviews_on_push: false`。
- `strict_required_status_checks_policy: true`（第一阶段已采纳：合并前分支必须与 `main` 保持最新）。
- 必需检查按名称匹配（`context: "validate-merge"`），没有 `integration_id`，因此任何能够创建该名称提交状态的主体都能满足它。
- `bypass_actors: []`。
- 只要本仓库的 `policies/rulesets.json` 变更进入 `main`，`apply-repository-settings.yml` 就会把该文件应用到所有受管仓库。因此一次合并就会改变每个受管仓库。
- `scripts/apply-repository-settings.ts` 在"当前 GitHub Free 组织"下会跳过私有仓库的 rulesets。2026-10-07 对 API 的检查显示：对于 `internal-vault`、`delta-suite` 与 `app-source`，rulesets 与分支保护接口都返回 403 "Upgrade to GitHub Pro or make this repository public"。**owner 决定（2026-10-07）：组织保持在 Free 套餐，私有仓库保持私有。** 因此这三个仓库永远不能拥有分支 ruleset，本提案只适用于四个公开仓库（`action-worker`、`ai-gateway`、`delta`、`external-vault`）。
- 组织有两名成员（`fongap`、`fongxen`）。

## 选项（各自独立）

1. **要求 1 人审批。** 每个 PR 都需要除作者之外的一人批准（GitHub 不允许作者批准自己的 PR）。在两人组织中，这意味着其中一人的每个 PR 都需要另一人批准。Dependabot 的 PR 与自动化 PR（工作指标、机器人提交）同样需要人工批准。风险：如果一人离开，就没有任何东西能合并，而且没有绕过主体可以退路（`bypass_actors: []`）。
2. **对控制路径要求 CODEOWNERS 审批。** 开启 `require_code_owner_review`，并使用 `CODEOWNERS` 文件（action-worker 已有；ai-gateway、app-source、external-vault、internal-vault 在 ORG-009 的 PR 中获得各自的文件：ai-gateway #78、external-vault #49、internal-vault #53、app-source #43）。GitHub 的规则是按仓库而非按路径：开启后，**每一个**被 CODEOWNERS 规则覆盖的文件都需要所有者批准，而 `*` 规则覆盖一切。要把它限制到 `.github/workflows/**`、`policies/**`、`scripts/**`、`contracts/**`，就必须从 CODEOWNERS 中删除全局的 `*` 行，这会使其他路径不再受所有者评审。这等价于选项 1 再加上指定谁可以批准。
3. **严格的状态检查。** `strict_required_status_checks_policy: true` 要求分支在合并前与 `main` 保持最新，从而使 `validate-merge` 在合并结果上运行。代价：在本组织中连续合并，每个未关闭的 PR 都必须在每次合并后更新（Dependabot 的 "rebase" 与 `allow_update_branch` 有所帮助；而我的 PR 大量堆叠）。
4. **把 `validate-merge` 绑定到发布它的应用（`integration_id`）。** 必需检查可以指定必须产生它的 GitHub App，但这只适用于 checks（Checks API），不适用于普通的提交状态。`validate-merge` 目前由令牌以提交状态的形式发布。绑定需要改用创建 check run 的 GitHub App，或至少改用专用的 App 身份：这需要新的基础设施（App 注册、将密钥存为 secret、轮换）。在此之前，任何拥有写权限和令牌的人都能发布该名称的状态。
5. **把 `fongap` 加为绕过主体**（未被要求，之所以列出，是因为选项 1 至 3 使其成为必要的紧急路径）。绕过应限于"仅 pull request"模式，而非"始终"。

## 建议（分阶段）

1. **私有仓库（已决定，无需配置）：** 补偿性控制是 Main Write Guard，它已经覆盖全部七个仓库。`intake.yml` 的 `Main write audit` 作业在受管仓库 `main` push 经桥接唤醒时即时重新审计每个受管的 `main`，并以定时运行兜底（GitHub 定时仅尽力而为，实际间隔可能达数小时）；无法追溯到通过确定性门禁的已合并 PR 的 `main` SHA，会得到 `Main Write Guard = failure` 并被标记为不可信，因此 Release、Deploy、Publication 与特权任务都会拒绝它（失败即关闭）。2026-10-07，所有七个仓库的 `main` 上该状态均为 `success`。剩余风险需要明确说明：私有仓库的 `main` 上的直接 push 无法被阻止，只能在下一次审计时被发现（通常由 push 即时触发，定时兜底），并且拒绝其任何官方输出。写权限应仅限于两名维护者，并保持审计工作流健康；失败或过期的 `Main Write Guard` 状态就是警报。
2. **第一阶段：** 对 PR 量较低的仓库采用选项 3（严格模式），然后观察一周。如果添加了仓库级覆盖，则通过仓库级覆盖实施，而不是通过共享文件；否则它将应用于所有仓库。
3. **第二阶段：** 当存在第二名常规评审者时采用选项 1（选项 5 作为紧急路径）。在此之前不要采用：在两人加上大量自动化 PR 的情况下，它会阻塞工作。
4. **第三阶段：** 只有在因其他原因引入 GitHub App 时才采用选项 4（它也有助于 AW-002 与 AW-007）。
5. 选项 2 不值得单独采用；使用选项 1 即可。
6. 以上每一项 ruleset 变更只影响四个公开仓库。

每个阶段的回滚方式：还原 `policies/rulesets.json` 中的变更；下一次 apply 运行会恢复之前的规则。

## 影响与风险

- 因为一次合并会改变每个受管仓库，应先通过 `apply-repository-settings.yml` 手动运行 dry-run 模式（`is_dry_run: true`）针对单个仓库进行试验。
- 导致 ruleset 无法满足的错误（例如要求审批但无人能批准）会在所有仓库中阻塞合并，包括用来修复它的那个 PR，除非存在绕过主体。应在添加任何审批要求的同一个 PR 中添加绕过主体，并先把审批要求应用到一个仓库上。
- 本次会话未能验证（GitHub 文档无法访问）：`integration_id` 能否匹配提交状态上下文（我认为它只适用于 check run）。私有仓库的 Free 套餐限制已不再是未决问题：上文引用的 API 响应已经确认了它。

## 需要 owner 决定

1. 采用哪些阶段，以及是否接受每个 PR 都需要对方批准（第二阶段）。
2. （已确定）私有仓库依靠 Main Write Guard；Free 套餐下不能为私有仓库设置 ruleset。
3. 是否引入 GitHub App。
