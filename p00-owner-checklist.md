# P-00：fongap-labs 组织人工操作清单（仅生成，未执行）

> 性质：本文件只列命令、前置、回滚与验证，**没有执行任何命令、没有读取任何密钥**。所有步骤由 owner 在自己的终端或 GitHub UI 中手工执行。
> 关联：审查报告 ORG-001/002/003/004/005/009/011、AW-002/AW-003。
> 命令默认为 bash（Git Bash 可用）；GitHub CLI 需先 `gh auth login`，且账号为组织 owner 并具备 `admin:org`、`repo` 范围。

## 0. 先读：核对中发现的 5 处需要你知晓的问题

| # | 问题 | 影响 | 处理 |
|---|---|---|---|
| 1 | **P-AW-3 提示词只覆盖部署与任务路径，没有给 `AW_ADMIN_TOKEN` 的消费者作业加 `environment: admin-ops`**（如 security-scan 的 publish、apply-repo-settings 等）。 | 若按 C3 删除仓库级 `AW_ADMIN_TOKEN`，这些作业会取不到令牌而失败。 | 在 P-AW-3 阶段 1 方案里要求代理枚举 `AW_ADMIN_TOKEN` 的全部消费作业并加上 `environment: admin-ops`；该密钥的 C3 排在最后。 |
| 2 | 任务路径（handle-task-dispatch）使用的密钥（CLOUDFLARE_*、ALGOLIA_*、AIG_ACCESS_KEY_TASK、TUSHARE/TIINGO/FRED/ALPHAVANTAGE 等）用 `env: ${{ secrets }}` 整体注入，**消费者无法按名字 grep 枚举**。一个作业又只能声明一个 `environment`。 | 把这些密钥只放进 `production` 并删除仓库级副本，会让任务作业失效。 | 删除任一仓库级密钥前，必须确认所有消费它的作业都已声明对应环境。P-AW-3 阶段 1 的 (e) 要明确任务路径是否引入按仓库划分的环境；未定之前**任务路径用到的密钥不要执行 C3**。 |
| 3 | 原清单的验证法「新建测试分支读取 `${#AW_ADMIN_TOKEN}`，长度应为 0」在 C1/C2 之后立即做是**无效**的，因为仓库级密钥还在，长度不会是 0。 | 会得到误导性结果。 | 本清单把该验证挪到 C3 之后，并增加「声明了环境但在非 main 分支运行应被拒绝」的第二项验证。 |
| 4 | 环境必须建在 **action-worker 仓库**（部署工作流在那里运行），不是 internal-vault。原文 C1 末句容易被理解成在 internal-vault 建环境。 | 建错仓库则环境保护不生效。 | 本清单明确：所有环境都建在 `fongap-labs/action-worker`。 |
| 5 | 缩小 GitHub App 权限，**由 App 的所有者在 App 注册页修改**，安装方（组织）只能卸载、暂停或限制仓库范围。 | 若 App 是第三方，无法移除其权限。 | 步骤 A 区分「自有 App」与「第三方 App」两种处理。 |

另有 3 个 API 细节我**未能在线核对官方文档**（文档查询工具在本会话不可用）。执行前请先按「先读后写」方式确认，不要直接写入：

- `sha_pinning_required` 是否为 `PUT /repos/{o}/{r}/actions/permissions` 的有效参数（步骤 F）。执行前用 `gh api repos/fongap-labs/ai-gateway/actions/permissions` 看返回里是否已有该字段；没有该字段时去官方文档 *REST API → Actions → Permissions* 核对。
- `PUT .../environments/{name}` 对未传字段（`reviewers`、`wait_timer`）是否会重置：对**已有**环境（如 `production`）先 `GET` 保存现状，再把现有值一并写回（步骤 C1）。
- 免费套餐下私有仓库是否可用 Environment 保护规则：本清单只在 **action-worker（公开仓库）** 上创建环境，规避该问题。

---

## 建议执行顺序

```
D（5 分钟，纯启用） → A（核查 + 收缩）→ B（创建只读令牌）→ C1 → C2
       → 合并 P-AW-1 / P-AW-2 / P-AW-3 并演练成功 → C3（逐个密钥）
E / F（组织默认 + 平台层固定）可与上面并行；G 是决策项；H 是复核项。
```

预计耗时：D 5 分钟；A 20–40 分钟；B 10 分钟；C1+C2 30–60 分钟（取决于密钥数量）；E 15 分钟；F 试点 30 分钟；G 决策；H 30 分钟。

---

## 步骤 D（ORG-009，立即）：启用私密漏洞报告

- **目的**：让外部研究者有私下上报渠道，不必公开提 issue。
- **前置**：仅限**公开**仓库（私有仓库不支持）。现有 4 个公开仓库：delta、action-worker、external-vault、ai-gateway。
- **命令（bash）**：
  ```bash
  for r in delta action-worker external-vault ai-gateway; do
    gh api -X PUT "repos/fongap-labs/$r/private-vulnerability-reporting"
  done
  ```
  PowerShell：
  ```powershell
  foreach ($r in 'delta','action-worker','external-vault','ai-gateway') {
    gh api -X PUT "repos/fongap-labs/$r/private-vulnerability-reporting"
  }
  ```
- **回滚**：把 `-X PUT` 换成 `-X DELETE`。
- **验证**：
  ```bash
  for r in delta action-worker external-vault ai-gateway; do
    echo -n "$r: "; gh api "repos/fongap-labs/$r/private-vulnerability-reporting" --jq .enabled
  done
  ```
  四行均应为 `true`。

---

## 步骤 A（ORG-003，立即）：核查并收缩 GitHub App

- **目的**：两个 GitHub App 权限过宽；先看清再收缩。
- **前置**：组织 owner。
- **步骤 1 · 盘点**
  ```bash
  gh api orgs/fongap-labs/installations \
    --jq '.installations[] | {id, app_slug, repository_selection, permissions}'
  ```
- **步骤 2 · 看仓库范围（只能走 UI）**：Organization Settings → GitHub Apps → Installed GitHub Apps → 对每个 App 点 Configure，记录「Repository access」。
  - REST 没有给组织 owner 直接列出某个安装下全部仓库的端点（需要 App 用户令牌），所以这里用 UI。
- **步骤 3 · 处理**
  - **闲置的 App**：Configure → Danger zone → Uninstall（或先 Suspend 观察一周）。
  - **自有 App**（你是 App 所有者）：Settings → Developer settings → GitHub Apps → Edit → *Permissions & events*，移除 `workflows`、`secrets`、`organization_secrets`（及不必要的 `administration`）。权限**降低**会立即生效，不需要再批准。
  - **第三方 App**：改不了其权限，只能把「Repository access」收窄为 Only select repositories，且**不含 action-worker、internal-vault、app-source**；仍不满意就卸载。
- **回滚**：自有 App 可在注册页重新勾选权限，组织侧需重新批准升级请求；卸载后可重新安装。
- **验证**：重新运行步骤 1 的命令，`permissions` 中不再有 `workflows`、`secrets`、`organization_secrets`；UI 中仓库范围符合预期。

---

## 步骤 B（AW-003 前置）：创建只读令牌 `AW_CHECKOUT_TOKEN`

- **目的**：让中央 CI 沙箱 / 依赖修复的计算作业在检出私有仓库时，不再使用高权限的 `AW_CONTROL_TOKEN`。
- **前置**：现有私有仓库是 internal-vault、delta-suite、app-source（私有 = 不支持私密漏洞报告的那三个）。
- **创建（UI，owner 亲自操作）**：GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token。
  - Resource owner：`fongap-labs`（若组织要求审批，需在组织 Settings → Personal access tokens 里批准）
  - Repository access：Only select repositories → delta-suite、internal-vault、app-source
  - Permissions：Repository → **Contents: Read-only**（Metadata 自动只读）。其余全部 No access。
  - Expiration：尽量短（建议 ≤ 90 天），并写入轮换日历。
  - 更好的长期方案：专用 GitHub App 安装令牌（见审查报告 XR-003），本步骤先用 PAT 过渡。
- **写入密钥（owner 在终端输入，值不要贴给任何代理或聊天窗口）**
  ```bash
  gh secret set AW_CHECKOUT_TOKEN --repo fongap-labs/action-worker
  ```
  命令会提示输入值；粘贴后回车。
- **回滚**：`gh secret delete AW_CHECKOUT_TOKEN --repo fongap-labs/action-worker`，并在 GitHub 上撤销该 PAT。
- **验证**
  ```bash
  gh secret list --repo fongap-labs/action-worker | grep AW_CHECKOUT_TOKEN
  ```
  能看到名称与更新时间即可（看不到值是正常的）。
- **注意**：该名称到位之前不要合并 P-AW-2。

---

## 步骤 C（ORG-002 / AW-002）：用 Environment 隔离生产密钥——顺序不可颠倒

> 所有环境都建在 **`fongap-labs/action-worker`**。

### C0 · 先读现状（避免覆盖已有设置）
```bash
gh api repos/fongap-labs/action-worker/environments --jq '.environments[] | {name, protection_rules, deployment_branch_policy}'
gh secret list --repo fongap-labs/action-worker
```
把输出另存一份，作为回滚依据。若 `production` 已有 reviewers / wait_timer，在 C1 里一并写回。

### C1 · 创建受保护环境（仅 main 可部署）
需要创建的环境：`admin-ops`、`production`，以及 internal-vault 的 `deploy.json` 所指的 `server-edge-cloud-edge`。

```bash
for env in admin-ops production server-edge-cloud-edge; do
  gh api -X PUT "repos/fongap-labs/action-worker/environments/$env" \
    -F 'deployment_branch_policy[protected_branches]=false' \
    -F 'deployment_branch_policy[custom_branch_policies]=true'
  gh api -X POST "repos/fongap-labs/action-worker/environments/$env/deployment-branch-policies" \
    -f name=main -f type=branch
done
```
- 对已存在且有 reviewers 的环境，先按 C0 的输出补上 `-F wait_timer=…` 与 `reviewers` 再执行，不要裸 PUT。
- **回滚**：`gh api -X DELETE repos/fongap-labs/action-worker/environments/<name>`（环境内的密钥会一并删除，所以 C2 之后不要随便回滚到这一步）。
- **验证**：`gh api repos/fongap-labs/action-worker/environments/<name>/deployment-branch-policies --jq '.branch_policies[].name'` 返回 `main`。

### C2 · 把密钥复制到环境（owner 逐个输入值，仓库级副本先保留）
| 密钥 | 目标环境 |
|---|---|
| `AW_ADMIN_TOKEN` | `admin-ops` |
| `CLOUDFLARE_API_TOKEN`、`AIG_ACCESS_KEY_*`、`AIG_TIER*_CREDENTIALS_*`、`AIG_TOKEN_ENCRYPTION_KEY`、`ALGOLIA_*` | `production` |
| internal-vault 部署所需的 3 个名称（见其 `deploy.secrets.allowed`） | `server-edge-cloud-edge` |

```bash
gh secret set <NAME> --repo fongap-labs/action-worker --env <ENV>
```
- 值只在终端提示符里输入。
- **回滚**：`gh secret delete <NAME> --repo fongap-labs/action-worker --env <ENV>`。
- **验证**：`gh secret list --repo fongap-labs/action-worker --env <ENV>`。
- ⚠ 任务路径用到的密钥（CLOUDFLARE_ACCOUNT_ID、TUSHARE/TIINGO/FRED/ALPHAVANTAGE 等）**暂不迁移**，见第 0 节第 2 项。

### C3 · 删除仓库级密钥（逐个，且必须晚于 P-AW-3 合并并演练成功）
**删除前核对清单（每个密钥都要过一遍）：**
1. 该密钥的所有消费作业都已声明对应 `environment:`。
   ```bash
   # 在 action-worker 本地克隆中
   grep -rn "<NAME>" .github/workflows
   grep -rn "secrets }}" .github/workflows   # 整体注入的位置；这些作业的环境必须已确认
   ```
2. 已用 `workflow_dispatch` 或 dry-run 路径演练过一次部署并成功。
3. 已确认 `AW_ADMIN_TOKEN` 的全部消费作业（security-scan publish、apply-repo-settings 等）都已加 `environment: admin-ops`。

```bash
gh secret delete <NAME> --repo fongap-labs/action-worker
```
- **回滚**：重新 `gh secret set <NAME> --repo fongap-labs/action-worker`（需重新输入值）。
- **验证（只能在 C3 完成后做）**
  - 测试 1：在新分支提交一个**不声明环境**的临时工作流，只执行 `echo ${#AW_ADMIN_TOKEN}`（打印长度，不打印值），触发 `push`；长度应为 `0`。
  - 测试 2：同一分支再提交一个声明 `environment: admin-ops` 的工作流；作业应被拒绝（提示分支不被环境允许部署）。
  - 完成后删除该测试分支。

---

## 步骤 E（ORG-004）：组织默认安全设置

- **目的**：新建仓库默认开启基础安全能力。
- **UI 路径**：Organization Settings → Code security（或 *Code security and analysis*）→ 为新仓库默认开启 Dependency graph、Dependabot alerts、Dependabot security updates、Secret scanning、Push protection；Settings → Member privileges → 关闭 Pages 创建；Settings → Member privileges / Admin repository permissions → 取消「允许仓库管理员邀请外部协作者」。
- **回滚**：UI 中把对应开关切回。
- **验证**：新建一个临时测试仓库，检查 Settings → Code security 是否按默认启用；检查完删除该测试仓库。
- 说明：对已有仓库，开关可在同一页面点「Enable all」。
- **按「Free 组织、私有仓库长期私有」的约束调整**：私有仓库的 Secret scanning / Push protection 属于付费能力，开了也不会生效，不要把它当作控制。私有仓库的替代做法：中央安全门（`policies/security.json`，已覆盖 OpenAI/Anthropic、NVIDIA、Hugging Face、Tailscale、Cloudflare、JWT 等格式）会检查每个 PR 新增的行；internal-vault 的 CI 另外运行固定版本的 gitleaks。Dependabot alerts / Dependabot 版本更新对私有仓库可用（本轮已为 app-source、delta-suite、internal-vault 配好）。

---

## 步骤 F（ORG-005）：平台层强制固定 SHA（先在 1 个仓库试点）

- **目的**：即使工作流里有人写了浮动标签，平台也拒绝运行。
- **前置**：确认 `sha_pinning_required` 是有效参数（见第 0 节）；先在 `ai-gateway` 试点。
- **步骤 1 · 汇总该仓库实际用到的 Action（在本地克隆里）**
  ```bash
  grep -rhoE "uses: [^@ ]+" .github | sort -u
  ```
  需要把 `actions/*`、`github/codeql-action`、`astral-sh/setup-uv`、`anchore/sbom-action` 等全部放行。另外检查 **可复用工作流**（`uses: fongap-labs/action-worker/.github/workflows/...@<ref>`）：开启 SHA 固定后它们也必须按完整 SHA 引用。
- **步骤 2 · 先读现状**
  ```bash
  gh api repos/fongap-labs/ai-gateway/actions/permissions
  gh api repos/fongap-labs/ai-gateway/actions/permissions/selected-actions
  ```
- **步骤 3 · 写入（先放行名单，再开启固定）**
  ```bash
  gh api -X PUT repos/fongap-labs/ai-gateway/actions/permissions/selected-actions \
    -F github_owned_allowed=true -F verified_allowed=false \
    -f 'patterns_allowed[]=astral-sh/setup-uv@*' -f 'patterns_allowed[]=anchore/sbom-action@*'
    # …按步骤 1 的汇总补全
  gh api -X PUT repos/fongap-labs/ai-gateway/actions/permissions \
    -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
  ```
- **回滚**：把 `sha_pinning_required=false`、`allowed_actions=all`。
- **验证**：重新跑一次该仓库的 CI，应通过；再临时提交一个用 `@v4` 浮动标签的工作流，应被拒绝。通过后再推广到其他仓库。
- **风险**：漏放行任何 Action 都会让 CI 失败；因此先试点。

---

## 步骤 G（ORG-001）：付费方案决策——已决定，无需操作

- **决定（2026-10-07，owner）**：fongap-labs 保持 **Free** 组织；现有私有仓库**长期保持私有**。因此 **不升级、不做任何"让私有仓库获得分支保护"的操作**。
- **已用 API 验证的事实**：对 internal-vault、delta-suite、app-source，规则集和分支保护接口都返回 403「Upgrade to GitHub Pro or make this repository public」。这三个仓库永远不会有分支规则。
- **替代控制**：Main Write Guard（`main-write-audit.yml` 每 5 分钟核对一次所有受管仓库的 `main`）。无法追溯到"通过确定性门禁并已合并的 PR"的 `main` 提交会被标成不可信，发布、部署、发布产物和特权任务都会拒绝它。2026-10-07 七个仓库的该状态均为 success。
- **剩余风险（请记录为"风险接受"）**：私有仓库的 `main` 被直接推送无法被阻止，只能在约 5 分钟内发现并拒绝其产出。保持写权限只给两位维护者；`Main Write Guard` 状态变红或长时间不更新，就是警报。
- **建议记录的复审日期**：下一次有人提议"让私有仓库公开"或"升级方案"时复审；否则每年复审一次。
- ⚠ 向 `policies/rulesets.json` 合并任何变更仍需先看 action-worker `#439` 里的 ORG-006 方案：它在合并到 main 时会自动应用到 **四个公开仓库**（action-worker、ai-gateway、delta、external-vault）。

---

## 步骤 H（ORG-011）：组织级复核

- **组织级 Secrets / Variables**（需 `admin:org`）
  ```bash
  gh api orgs/fongap-labs/actions/secrets --jq '.secrets[] | {name, visibility, updated_at}'
  gh api orgs/fongap-labs/actions/variables --jq '.variables[] | {name, visibility}'
  ```
- **Webhook 与 Deploy key（各仓库）**
  ```bash
  for r in delta action-worker external-vault ai-gateway internal-vault delta-suite app-source; do
    echo "== $r"; gh api "repos/fongap-labs/$r/hooks" --jq '.[]|{name,active,url:.config.url}' 2>/dev/null
    gh api "repos/fongap-labs/$r/keys" --jq '.[]|{title,read_only}' 2>/dev/null
  done
  ```
- **Fine-grained PAT 策略**：Organization Settings → Personal access tokens → Settings（是否要求审批、是否允许经典 PAT）与 Active tokens（列出已批准令牌）。
- **审计日志（近 90 天）**：Organization Settings → Archive → Audit log（UI）。通过 API 读审计日志需要 Enterprise Cloud，Free 组织不可用。
- **三个调度/控制/管理令牌**（`AW_DISPATCH_TOKEN` / `AW_CONTROL_TOKEN` / `AW_ADMIN_TOKEN`）：判断是 PAT 还是 App 令牌——看工作流里是否使用 `actions/create-github-app-token`（`grep -rn create-github-app-token .github`），并向创建者确认。登记：类型、权限、有效期、轮换负责人。`gh secret list` 只显示名称和更新时间，不会暴露值。
- **回滚**：本步骤只读，无需回滚。

---

## 完成后自检

| 检查 | 方法 |
|---|---|
| App 权限已收窄 | 步骤 A 命令 1 的输出中无 `workflows`、`secrets`、`organization_secrets` |
| 私密漏洞报告 | 步骤 D 验证，四个公开仓库均为 `true` |
| 只读令牌就绪 | `gh secret list --repo fongap-labs/action-worker` 含 `AW_CHECKOUT_TOKEN` |
| 环境已建 | C1 验证，`deployment-branch-policies` 为 `main` |
| 密钥已隔离 | C3 之后做测试 1 与测试 2 |
| 平台固定 SHA | 步骤 F 试点仓库 CI 通过，浮动标签被拒 |

---

## 附录：本轮修复之后的待办与决策（2026-10-07 更新）

> 前提（owner 决定）：Free 组织；私有仓库长期私有。

### 已完成

- 我在你的授权下按顺序合并了 41 个 PR（action-worker、ai-gateway、app-source、delta、delta-suite、external-vault、internal-vault 的修复与测试）；所有合并都是 squash，没有开自动合并。
- 在 `C:\Users\Fong\.claude\settings.json` 加了一条只允许对 fongap-labs 执行 `gh pr merge … --squash` 的权限规则；不需要时可删除。

### 还没合并的 PR

| PR | 状态 | 在等什么 |
|---|---|---|
| external-vault `#48` | 检查全绿 | 你先做一次手动检查：往 `adfilter.txt` 临时加 `ghp_` 加 36 位字母数字，应当报警；然后我再合 |
| action-worker `#439`、delta `#118`、internal-vault `#54`、app-source `#44` | 只有方案文档 | 你拍板 |
| delta `#119` | 清理 deny.toml 里 10 条已撤销的 gtk3 忽略项 | 审一下即可合并 |
| Dependabot：internal-vault `#55`–`#64`、app-source `#45`、delta `#103`–`#112` | 检查是红的（作者不被信任，没有 CI 证据） | 见下面"Dependabot 建议" |

### Dependabot 建议（我没有动任何一个）

这些 PR 的检查是红的，原因是作者是机器人、不属于受信作者：要让 CI 跑起来，需要由你（或 fongxen）在 GitHub 上先审阅并 Approve，之后检查才会运行。这一步我不替你做。

- **可以先审、风险低**：internal-vault `#55`（ruff 补丁）、`#57`（mypy 小版本，可能多几条类型报错）；app-source `#45`（cryptography 50.0.1→50.0.2，补丁）；delta `#107`（ruff 补丁）、`#105`（simple-icons 补丁）、`#103`（前端开发依赖组）。
- **先别合，要配套改代码**：internal-vault `#59`、`#60`（boto3 1.35→1.43）。1.36 之后 boto3 默认会给上传加校验和，Cloudflare R2 常因此报错；`bricks/r2_storage_upload.py` 目前没有设置 `request_checksum_calculation="when_required"`。要和这项配置一起改并实测一次 R2 上传。
- **大版本，风险高**：internal-vault `#56`（pandas 2→3）、`#61`（yfinance 0.2→1.7）、`#62`、`#64`（pyarrow 23→25，与 pandas 相关，代码里大量使用 parquet 读写）。建议单独做一轮升级，逐个跑完整的行情抓取流程。`#63`（tushare 补丁）和 `#58`（packaging 24→26）中等，放在上一批之后。
- **Tauri 系列要一起升**：delta `#104`+`#108`（opener 前端/Rust 成对）、`#106`（@tauri-apps/api）、`#109`（updater，和更新器有关，优先审）、`#110`、`#111`、`#112`。Tauri 的前端包和 Rust 包主版本要对得上；单独合其中一个可能让构建报"版本不一致"。建议关闭这些单独的 PR，改成一次整体升级并实际构建验证。

### 你要做的人工动作

- **P-00 的 GitHub 设置**（A、B、C1/C2、D、E、F、H）：见上文各步骤；**C3（删仓库级密钥）要等 AW-002 的实现并演练成功之后**。
- Windows 代码签名证书，以及放进受保护 Environment 的两个密钥（delta `#117` 已合并，没证书时构建不变）。
- SECURITY.md 的备用联系方式（TODO 标记在 action-worker 的 `SECURITY.md` 里）。
- 服务器主机侧：Tailscale Auth Key 属性、sudoers / authorized_keys、核对真实实例 `.env` 的格式（见 internal-vault `#54`）。
- 找法务确认：AdFilter 聚合文件的许可证组合（见 external-vault `#47`）。
- 创建 license 服务的 code-pepper 文件；决定临时访问 GUI 里"不为临时公钥包裹文件密钥"的默认值。
- 可删除旧克隆：`C:\AgentHub\fongap-labs\action-worker`。

### 等你拍板的决策

| 事项 | 在哪个 PR | 我的建议 |
|---|---|---|
| 密钥用 Environment 隔离，任务路径怎么做（A/B/C） | action-worker `#439` | 先只做部署路径；环境都在公开的 action-worker 里，不受"Free + 私有"影响 |
| CI 控制路径（AW-005） | `#439` | 标准工具用固定命令；其余写进文档 |
| 分支规则加严（ORG-006） | `#439` | 只影响 4 个公开仓库；先"严格状态检查"，再考虑"需要 1 个审批 + 保底豁免" |
| 凭据存储（DL-002） | delta `#118` | 先做第 1 步（文件创建即受限、按 SID 判断） |
| 服务器部署加固（IV-004/005） | internal-vault `#54` | (a)(c)(e) 可做；(b) 先选信任锚 |
| 作者密钥文件 SPKEY02（APP-007） | app-source `#44` | scrypt N=2^16；新文件，不覆盖旧文件 |
| **要发布的版本号（APP-011）** | app-source `#44` | 请告诉我 2.0.0 还是 0.1.0 |
| 中央 CI 引入固定版本 gitleaks | action-worker `#436` 说明 | 单独一步做 |

### 私有仓库的静态检查（替代 CodeQL）

CodeQL 对私有仓库需要付费，所以我在本机做了一次性的替代扫描（没有改 CI）：

- internal-vault（bandit）：无高危；9 个中危，多为固定的 /tmp 路径和已校验哈希的 Hugo 下载；唯一值得留意的是 `bricks/source_fetch.py` 用 `ElementTree` 解析外部 RSS（建议改 `defusedxml`，优先级低）。
- delta-suite（bandit）：无高危；2 个中危是拼接 SQL 的告警，数值经 `resolve_limit` 限制，不是注入。
- app-source（clippy + cargo-deny）：无错误，只有 6 条风格警告；`cargo deny check advisories` 通过。
- 注意：中央 CI 对私有仓库隐藏详细日志，所以如果以后把这些扫描加进 CI，只能是"通过/失败"，细节要在本机复现。是否加进 CI 请你定。
