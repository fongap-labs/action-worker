# Changelog

## [Unreleased]

- 新增: 按六类类别整理 CHANGELOG 条目；门禁校验类别与 PR 类型的映射、中文摘要、乱码与安全属性，发布时可按类别生成带版本链接的小节。

- 修复: 被取消或被较新运行取代的中央 CI 不再把失败写入 CI Evidence；自动发布的 PR 门禁失败后保持开放，不再被自动关闭，其中央 CI 也不会被连带取消。

- 安全 [security]: `PR Governance`、`validate-merge` 与 `Main Write Guard` 状态只有在控制仓库确实存在成功运行、且状态在该运行期间写入时才计入。此前任何能写 commit status 的账号都可以让状态指向不存在的运行，使 main 写入被视为可信。

- 安全 [security]: 任务与部署的密钥模式默认改为 `enforce`。策略未列出的任务项目会被拒绝，并提示需要添加的策略条目。此前 `warn` 模式只记录日志，未列出项目的密钥上限为空，却授予其声明的全部名称。

- 安全 [security]: 源脚本部署的权限由控制面决定。`policies/deploy-environments.json` 列出每个仓库允许部署的环境，未列出的请求以退出码 77 失败；`policies/deploy-secrets.json` 限定每个仓库与环境可声明的密钥；部署检出改用只读的 `AW_CHECKOUT_TOKEN`；使用 `AW_ADMIN_TOKEN` 的作业在 `admin-ops` 环境中运行。

- 安全 [security]: 私有任务源的任务状态与失败日志只以 `AW_ARTIFACT_KEY`（AES-256-GCM，绑定类型、仓库与项目）加密上传，没有密钥则不上传任何私有内容。失败的私有任务日志可用 `node scripts/task-state.ts open-log` 查看。

- 安全 [security]: 失败的私有任务不再以 `task-log-*` 制品上传，因为公开仓库的制品可被任何登录用户下载；日志只保留在运行器上。

- 安全 [security]: PR 门禁只接受真正由发布工作流成功运行产生的 `CI Evidence`（`hasVerifiedCiEvidence`）。中央 CI 的后续作业（安全扫描、主写入审计、自动部署）改为独立的 `follow-up` 作业运行，其失败不会使通过的 CI 变红。

- 安全 [security]: Linux CI 沙箱新增中央密钥扫描：固定版本 gitleaks 8.30.1，SHA-256 校验，在任何目标代码运行前扫描 PR 新增的提交。默认只警告，设置 `AW_CENTRAL_GITLEAKS_MODE=enforce` 后发现即失败。

- 安全 [security]: 公开仓库的 main 规则集要求 PR 与最新 `main` 同步后才能合并（`strict_required_status_checks_policy: true`），`validate-merge` 在合并结果上运行。私有仓库（免费版套餐）无法使用规则集，依赖 Main Write Guard。

- 安全 [security]: 安全门禁新增对 OpenAI 与 Anthropic（`sk-ant-`、`sk-proj-`、旧式 `sk-`）、NVIDIA `nvapi-`、Hugging Face `hf_`、Tailscale `tskey-`、`CLOUDFLARE_API_TOKEN` 赋值与 JWT 的检测。`policies/security.json` 的 `secret_allowlist` 只放行路径与匹配文本同时一致的已知无害值。

- 安全 [security]: 私有目标在 CI 沙箱与依赖修复计算作业中改用只读的 `AW_CHECKOUT_TOKEN` 检出，运行变更代码的作业不再持有可写凭据。检出凭据不再持久化到依赖修复发布、验证与任务派发工作流中。`security-scan.yml` 拆分后，CodeQL 不接触密钥，只有单独的发布作业持有 `AW_ADMIN_TOKEN`。

- 安全 [security]: 任务执行前在 `handle-task-dispatch.yml` 中重新验证任务源：`bootstrap_ref` 必须是目标仓库当前默认分支的 HEAD，携带有效的 CI Evidence，并通过 Main Write Guard。伪造的 `run-task` 派发无法让执行器运行任意提交。

- 安全 [security]: 部署源门禁、任务源门禁与 Main Write Guard 通过控制仓库中产生该证据的运行来验证 `CI Evidence`（发布工作流、默认分支、成功结论，且状态在运行期间写入），不再信任 `target_url` 的前缀。

- 安全 [security]: AI 审查引擎二进制按 `policies/review.json` 中的 SHA-256 固定。安装器只在二进制、固定摘要与发布校验文件三者一致时接受，替换的发布资产无法为自己作证。

- 安全 [security]: 作者没有写权限的 PR，只有在维护者批准当前 head 提交后才运行中央 CI，并在中央 CI 工作流内重新检查，然后才执行任何变更代码。

- 安全 [security]: Linux 与 Windows 中央 CI 作业移入 `central-ci-sandbox.yml`。该工作流不引用任何中央密钥，只在私有目标时接收检出令牌。

- 安全 [security]: 部署与任务入口在移除越界密钥后以 `exec` 启动，私有仓库任务的输出不写入运行日志。

- 安全 [security]: 任务状态制品按仓库与项目的哈希命名，并附带 `manifest.json`。恢复时忽略清单指向其他仓库或项目的制品，两个任务源不再相互共享或污染状态。

- 安全 [security]: Validate CI 中的 actionlint 从固定版本的发布包安装，并校验 SHA-256，不再执行从 `main` 分支获取的脚本。

- 安全 [security]: CI 派发、依赖修复、Release 构建与安全扫描工作流把 `needs.*.outputs` 通过 `env` 传给 shell 步骤，不再直接粘贴进脚本。安全门禁新增 `expression-as-shell-argument` 规则，防止该模式再次出现。

- 安全 [security]: 公开仓库的 CodeQL 扫描覆盖 Action Worker 自身的 TypeScript 与 workflow 文件（`.github/security-scan.json`），安全扫描契约接受 `actions` 语言。

- 安全 [security, migration]: 工具同步只从带有效 GitHub 签名的默认分支 HEAD 发布。未签名的 HEAD 会延后同步，发布标签不会指向未经验证的提交。

- 修复: 中央 CI 以 PR 合并进默认分支后的结果进行测试（检出 `refs/pull/<number>/merge`）。基于旧默认分支的 PR 不再因他人已改动的代码而失败；冲突的 PR 在检出步骤失败，密钥扫描与状态判定保留 PR 自身的提交。

- 修复: triage 接受链接的 worktree 作为仓库根目录。门禁此前要求 `.git` 是目录，而链接的 worktree 中它是指向共享对象库的文件。

- 修复: follower 的 uv.lock 补丁可以再次应用。`lock-follow` 读取 `git diff` 时去掉了末尾换行，`git apply` 因此拒绝补丁，锁文件从未提交；现在保留换行，提交作业为旧产物补齐最后的换行。

- 修复: follower 的 uv.lock 在上游发布后正确提交。一个 follower 时产物平铺在下载根目录，多个 follower 时每个一个目录；提交作业此前只接受后者，因此单个 follower 的首次发布失败。两种布局现在读取同一份请求，并由单元测试固定。

- 修复: 受管仓库的发布与部署重新通过 main 写入门禁。可信列表只包含 `main-write-guard.yml`，但受管仓库的 main 由 Intake、中央 CI、Release App、部署与任务源通过 `audit-main-writes.ts` 证明；现在列表包含所有运行审计的工作流，并由契约测试与 `.github/workflows` 保持同步。

- 修复: 版本计算从 GitHub 提交 payload 的 `commit.message` 读取提交标题。此前读取的顶层 `message` 字段在提交 API 中并不存在，导致空的 `requested_version` 直接失败，而不是提议下一个版本。

- 修复: 工作流表达式被粘贴进 shell 命令的检查重新生效。引号内任意位置的表达式都计入；`env` 中作为普通 YAML 值的表达式仍然允许。

- 修复: 门禁状态只属于仍在运行的 PR 治理。关闭的 PR 的取消工作流不再停止已合并 PR 的治理运行，否则 main 会一直处于不可信状态。只有被放弃的 PR 才取消治理工作。

- 修复: 被合并的 PR 保留其治理运行，main 的来源证明不会因此失效。

- 修复: 自动部署重新启动。工作流与部署作业此前使用相同的并发组，导致部署作业等待自己的运行而从未开始；现在工作流组使用 `source-script-deploy-pipeline-` 前缀。

- 修复: 发布标题为产品的 `release_name` 加上纯版本号（如 `Delta v0.1.0`），没有 `release_name` 时为 `v<version>`。标签仍为 `<release-key>-v<version>`，因为 `external-vault` 托管多个产品的发布，标签必须唯一。

- 修复: internal-vault 的 server-edge CI 步骤属于可信控制路径。修改 `.github/scripts/server-edge-ci.sh` 的 PR 使用自身的脚本检查，不再使用仍指向 `services/server-edge` 的基础分支副本。

- 修复: ai-gateway 的生产部署重新接收 `CLOUDFLARE_ACCOUNT_ID`，别名为 `CLOUDFLARE_ACCOUNT_ID_SECONDARY`。此前的移除假定它是仓库变量，但实际上该名称不存在，只有 `_SECONDARY` 是变量，而部署预检要求 `CLOUDFLARE_ACCOUNT_ID`。

- 修复: 推送的项目若没有 `task.json` 且排在有 `task.json` 的项目之后，任务源作业不再静默退出 1，而是跳过该项目并继续派发其他任务项目。

- 修复: 定时任务补跑恢复。`TASK_SOURCE_LOOKBACK_MINUTES` 恢复为 720，每个项目只派发最近一个到期时段；并且补跑过去 12 小时内所有未派发的时段，每个时段派发一次（由源提交上的 `Task Schedule/<project>` 状态记录）。此前只看最近 20 分钟，观察到的 13 个时段一个都没有派发。

- 修复: 定时任务派发的 `request_id` 改为 `task-schedule-<identity>`（连字符）。此前冒号格式在入口校验时被拒绝，导致 MarketBrief、PharmaBrief、FongapBlog 与 AdFilter 的所有定时任务失败。

- 修复: 清理已删除工作流运行记录的作业：遇到 HTTP 404 的工作流时跳过并记录在运行摘要中；删除最后一条运行后的重新读取把 404 视为"没有运行"；其他失败仍会停止作业，并在错误中写明请求路径。

- 修复: 中央 CI 的后续作业不再因目标没有 Windows CI 而被跳过。此前缺少状态函数，这些仓库的安全扫描、main 写入证明与自动部署都不会运行；现在只要 `finalize` 成功即运行。

- 修复: Release App 与手动 Deploy Source Script 在检查源之前为该源请求中央 CI，检查最多等待 20 分钟。发布检查使用 `requireVerifiedCiEvidence`，确认成功的中央 CI 运行确实写入了状态；两个工作流的 `prepare` 作业超时为 30 分钟。

- 修复: Release App 与 Deploy Source Script 在门禁前用 `audit-main-writes.ts` 为源 main 写入做证明，不再只等待 60 秒。步骤不阻塞，门禁仍是权威。

- 修复: 中央 CI 运行期间 main 前进时，自动部署不再丢失。若之后的提交全是源会跳过的文档，则部署当前 main（已包含该变更）；否则较新的 main 在自己的中央 CI 后部署。

- 修复: 中央 CI 在 PR 的准备作业中停止时（例如不可信作者修改了 CI 控制文件），当前 head 写入 `CI Evidence = failure` 并附运行链接。此前状态一直 pending，PR 治理要等 120 分钟才超时。

- 修复: 维护者批准前，等待批准的 PR 不再每五分钟重新派发 PR 治理。不可信的 head 报告为 `Awaiting maintainer approval of the current head commit`；Central PR Intake 只在维护者批准当前 head 后再次派发。

- 修复: PR Intake 不再为已有结论的 PR head 重新派发治理与中央 CI。仅移动默认分支（控制修订）不会重新派发已完成状态的 head；被取消的待定状态会重试。此前每次 main 推送都会重新派发所有失败的 PR。

- 修复: 自身 CI（`validate-ci.yml`）只为 PR 取消被取代的运行。main 上较新的推送不再取消较早的 main 提交的验证。

- 修复: 没有 `deploy` 能力的仓库跳过自动部署步骤，不再以退出码 77 失败；delta、delta-suite、app-source 与 external-vault 的绿色 main 推送不再以中央 CI 失败结束。

- 修复: 合并时仍在等待或运行建议性 AI 审查的 PR 继续获得审查与评论；未合并就关闭的 PR 仍被跳过。

- 修复: 建议性 AI 审查作为独立工作流，只在确定性门禁通过后启动。PR 不再排在等待中央 CI 的无关运行之后，治理运行随门禁结束。

- 修复: 文件名超出安全字符集（如非 ASCII 名称）的 PR 不再中断所有仓库的依赖修复对账，该 PR 被视为不适用依赖修复。

- 修复: 任务发布改为经治理的 PR 合入，不再直接推送到受保护的目标分支。

- 修复: 发布源门禁接受中央 CI Evidence。源仓库不再运行本地 `ci.yml` 时，此前的检查会失败。

- 修复: 安全门禁的 diff 缓冲区加大，使大型生成的发布产物也能被扫描（此前超过 16 MiB 上限）。纯数据内容文件豁免工程语言门禁，使生成的发布产物能通过治理检查。

- 修复: PR 的项目类型先依据变更的 monorepo 路径检测，再回退到仓库根清单。

- 修复: Python 命名校验拒绝变更时输出详细诊断。

- 修复: 一组 PR 与中央 CI 状态的竞态问题：短期保留 CI Evidence，相邻的对账运行不再为同一个不可变提交重复派发；重复的 main SHA 派发串行化，并复用成功的 CI Evidence；PR 治理在控制修订前进后重试，但不在同一修订上循环；已关闭 PR 的取消目标在进入并发组前校验；关闭 PR 时取消过期的 PR 治理与中央 CI。

- 修复: 过期的 PR 治理运行不再覆盖较新运行的评论与最终提交状态；PR 治理并发按当前控制面修订分组，过期运行不会阻塞较新的 Action Worker 发布。

- 修复: `validate-merge` 只由可信的 GitHub Actions 检查发布，中央 CI 不再发布冲突的提交状态。

- 修复: 治理计划不要求 CI 时，显式发布成功的 CI Evidence，最终合并门禁不再从缺失的证据推断意图。

- 修复: AI Gateway 的源 SHA 通过 `AIG_BUILD_SHA` 注入，不再使用控制面的 GitHub SHA。

- 修复: 工程语言检查把 HTML 模板标签之间的文本视为面向用户的界面文案。模板注释与模板中嵌入的日志仍需英文；多行注释块的每一行都归属该注释，中文注释不能藏在行与行之间。

- 修复: 工程语言检查正确读取 git diff 中带引号的非 ASCII 路径头，避免把其他文件的中文页面文本误判为 CHANGELOG 条目。

- 修复: 工程语言规则不再报告压缩打包文件（`*.min.js`、`*.min.css`）中的非英文文本；作者编写的代码中同类文本仍会报告。

- 修复: 机器交互内容只用英文：`impact_patterns` 只保留英文关键字，AI 审查引擎配置为英文输出。

- 修复: 共享命名校验区分工程生命周期标签与限定的领域概念；Python、Rust 与 TypeScript 的变更源码命名校验集中实施。

- 修复: `APP_SOURCE_` 外部配置前缀作为与上下文无关的系统身份；承认带作用域的业务所有者，同时仍拒绝依赖上下文的通用名称；把 MODE 配置名视为非布尔值。

- 修复: 下游 bootstrap 执行前，只读的任务执行凭据与中央控制、发布凭据隔离。

- 修复: 统一以 `main` 作为最新的控制基线，移除残留的 `v1` 引用。

- 修复: CHANGELOG 更新归为文档类，只有真正的发布语义或声明的发布影响才选择发布审查；发布 AI 审查的范围包含 JSONC 部署配置与 CHANGELOG。

- 修复: 代码最小化审查指南合并进每个文件唯一的 OpenCodeReview 规则条目，不再被当作重复路径模式丢弃。

- 修复: 发布 AI 审查使用 Code-Max，阻断策略不变。

- 修复: AI 审查设置：禁用的审查权限对所有仓库（包括 AI Gateway 引导）生效，模型覆盖不能静默重新启用审查；普通代码审查的任务预算为 5 分钟，覆盖 300 秒 LLM 超时；为打破 AI Gateway 的自审循环，临时使用授权的 Audit-Max 模型审查；AI Gateway 引导审查使用中央配置的模型，同时保留架构规则、高强度与关键阻断。

- 修复: 短暂的 AI 审查失败增加有界指数退避的会话恢复，保持 FIFO 单并发。

- 修复: 分诊与 AI 审查跨 Action Worker 修订串行化，避免 main 更新产生并发的 AI Gateway 调用方。

- 修复: 自动 PR 创建被拒绝时清理临时指标分支；本地指标 PR 的创建与合并使用仓库范围的 GitHub 令牌。

- 修复: 审查分发与发布仓库白名单移入版本化的治理策略；OpenCodeReview 分发仓库从规范的 Action Worker 仓库变量解析；强制规范的治理配置名称，并限制治理令牌的指标变更。

- 修复: OpenCodeReview 清单的失败分类与原因输出到治理日志。

- 修复: 中央 CI 证据等待最长两小时，PR 治理仍在三小时的执行预算内。

- 修复: 轻量仓库合并门禁保持 GitHub Actions 必需检查的身份，中央 CI 失败详情只向公开目标展示。

- 修复: 发布产物的 `validate-merge` 与 PR 治理状态统一由一个可复用工作流创建，并满足 GitHub Checks API 的契约。

- 修复: 合并门禁从 PR 治理的最终提交状态触发，并通过 `repository_dispatch` 触发；反向跨仓库派发凭据已移除。

- 修复: Delta 注册为外部配置的规范所有者，与仓库无关的名称统一使用 `DELTA` 前缀。

- 修复: 通过 `repository_dispatch` 触发仓库合并门禁。

- 修复: 同一修订上的 AI Review 重跑按当前尝试开始时间排序，复用的低运行 ID 无法绕过全局 FIFO 队列。

- 修复: 工作指标汇总作业对本地 Actions 与清理仍使用工作流范围的令牌，只有 PR 创建使用 `AW_CONTROL_TOKEN`。

- 修复: 陈旧的指标分支清理独立于源工作流成功与否运行，并在每次指标更新前清理已关闭的陈旧分支。

- 修复: 指标工作流本身变更时，清理陈旧指标分支的引导自动运行。

- 修复: 发布与部署的 Release App 与 Deploy Source Script 中，`source_sha` 为空时部署默认分支当前 HEAD；无效的仓库或 SHA 失败时给出包含输入名的消息。

- 修复: 中央 CI 派发、发布与门禁错误给出下一步操作：仓库名错误时建议 `owner/name`，缺少能力时列出具备该能力的仓库，CI Evidence 与 Main Write Guard 失败时指出要打开的运行与要启动的工作流。


- 修复: 跟随型产品的固定值与上游已发布版本不匹配时，发布前拒绝并指出文件与键。

- 修复: 删除过时的 `AW_EXECUTION_TOKEN` 指南，记录 GitHub 免费版私有仓库保护的限制。


- 修复 [migration]: `CLOUDFLARE_ACCOUNT_ID` 的别名与部署密钥上限保持一致，部署作业仍接收仓库变量。

- 修复 [migration]: delta-suite 契约测试不再要求 `pyproject.toml` 中的 Foundation 包版本；Foundation 兼容性只由不可变提交与能力 ABI、工作进程清单、连接器目录格式版本固定。


- 变更: 将 `CHANGELOG.md` 的历史修正为不含 AI 署名 trailer 的提交：默认分支中一次带有 `Co-Authored-By:` 的提交被重写，树、作者、提交者与消息均保持不变；重写期间临时放宽 main 规则集，之后恢复。

- 变更: 治理入口与发布自动化对齐：版本计算随 `.githooks/commit-msg` 与 `commitlint.config.js` 一起提供，CONTRIBUTING.md 作为贡献者入口。

- 变更: 文档改为英文，中文只保留在 `*.zh-CN.md` 本地化文件中（包括 `SECURITY.zh-CN.md`），由测试强制。业务仓库仍保留 Markdown 豁免。

- 变更: `CLAUDE.md` 增加提交卫生规则：不得出现 AI 代理身份或署名（如 `Co-Authored-By:`、`Generated with`），标题与正文中也不得出现代理、模型或厂商名称。

- 变更: 门禁说明改为确定性策略加 CI Evidence，AI 审查在门禁通过后异步运行且只提出建议。删除没有策略依据的"审查阻断阈值"项。

- 变更: 仓库文档默认使用英文，并增加简体中文伴随索引。

- 变更: 工作流统一使用固定版本 `actions/setup-node@v7.0.0`，拒绝已退役的 v4 固定版本。

- 变更 [breaking]: 删除重复的 `ci-evidence` 提交状态别名，`CI Evidence` 是唯一的中央 CI 状态上下文。

- 变更 [breaking]: Release Governance 的源身份与产物运行身份分离，并要求按契约签名的发布来源证明。

- 变更 [breaking, migration]: 外部配置名称统一加 AW/AIG 系统标识命名空间，强制与上下文无关的外部名称；给出最小充分命名规则，并登记 AW/AIG 系统缩写。与上下文无关的配置语义优先于任意段数限制；共享配置名称一次性切换，非规范配置标识符被拒绝。

- 变更 [breaking, migration]: 发布版本只来自发布时输入的版本，且必填。Release Build 不再读取源仓库的版本或与之比较；清单删除 `version_source`；构建脚本以 `-Version` 接收版本。delta 测试包删除版本一致性检查。

- 变更 [migration]: 发布与部署工作流按类型重命名：`Release Build Dispatch` 改为 `Release App`（`release-app.yml`），`Sync Tool Release` 改为 `Release Tool`（`release-tool.yml`），`Source Script Deploy` 改为 `Deploy Source Script`（`deploy-source-script.yml`）。事件、输入与行为不变，按旧名称启动的调用方须改用新名称。

- 变更 [migration]: 每个工作流属于一个类别（入口、Intake、处理器、维护或可复用），`tests/workflow-classes.test.ts` 强制执行。只有 Release App、Deploy Source Script 与 Task Source Dispatch 保留手动运行按钮；所有工作流默认无写权限，每个作业有超时，每个工作流都有并发组。

- 变更 [migration]: 一个 Intake 工作流（`intake.yml`）替代 PR Intake、CI Intake、Task Intake、Security Scan Intake 与 Main Write Audit，Task Source Dispatch 不再定时运行。GitHub 对本仓库五分钟定时的执行间隔为 2.6 到 9.8 小时，因此 Intake 也会在每次 main 推送与 `run-intake` 事件时运行。任何按旧名称启动工作流的调用方必须改发 `run-intake`。

- 变更 [migration]: 业务仓库使用统一的通知桥接 `templates/bridge/notify-action-worker.yml`（`Notify Action Worker`，已在 `policies/security.json` 中批准）。PR 打开、更新或重开时发送 `run-pr-governance`，关闭时发送 `cancel-pr-work`，main 推送时发送 `run-intake`。它取代 `dispatch-pr-governance.yml` 与仓库自有的 `ci.yml` 派发器；旧方式在仓库切换前仍可用。

- 变更: Apply Repository Settings 每天运行一次，手工在受管仓库中改动的设置会回到共享策略。

- 变更: 删除未被调用的可复用工作流（`validate-central-merge`、`validate-deploy-policy`、`validate-source-policy`）。`apply-repo-settings` 重命名为 `apply-repository-settings`，各 Intake 的显示名称与派发入口的显示名称统一为文件名。

- 变更: 工作流按统一规则命名，并由 `tests/workflow-naming.test.ts` 检查：由 `repository_dispatch` 启动的工作流取最完整且可用的名称（`handle-<subject>-dispatch.yml`、`<subject>-dispatch.yml`、`<subject>.yml`）。`handle-pr-dispatch` 与 `handle-pr-review` 为已记录的例外。

- 变更: 工作指标汇总作业的检出不持久化凭据；推送时只为单次调用通过进程环境注入凭据。

- 变更: 工作指标徽章改用 GitHub 品牌配色与 Shields 默认标签背景；Dispatch 徽章更名为 Task Dispatch；Dispatch 定义为成功的 Handle Task Dispatch 运行，并依据已完成的治理事件更新全部徽章。

- 变更: 工作指标每日重算，并自动更新任务派发、PR 治理与发布治理的数据。

- 变更: 工作流定时清理陈旧分支的作业更名为 Prune Stale State（`prune-stale-state.yml`）。新作业删除文件已不在 `main` 中的工作流的运行记录，最后一次运行两天后删除，每次最多 400 条。

- 变更: Main Write Guard 工作流只守护 Action Worker 自身的 `main`；无发送者的 `run-main-write-guard` 与 `refresh-work-metrics` 事件已移除。

- 变更: 任务派发在 PR 合并时间内完成门禁；Release App 与 Deploy Source Script 为其源请求中央 CI，等待时间与任务源门禁共用 `centralCiWait`。

- 变更: Task Source Dispatch 为该仓库直接请求中央 CI（`AW_CI_INTAKE_REPOSITORY`），不再依赖每几小时才运行一次的定时 CI Intake。

- 变更: 工具同步需要显式传入工具键（`scripts/sync-tool-release.ts <policy> <artifact-dir> <tool-key>`），工作流对 `open-code-review` 与 `r-base` 分别运行矩阵。同步不再从审查策略的 `engine.name` 取工具，因此 `r-base` 这样的目录条目可以被使用。

- 变更: 工具分发支持镜像一个固定哈希的 HTTPS 文件（`"distribution": "url"`），上游文件 SHA-256 不符时同步在发布前失败；URL 必须是 HTTPS 且不含凭据。GitHub Release 分发保持不变，未知分发方式会失败。

- 变更: 自动化作业与 OpenCodeReview 调整：普通 Code-Pro 审查任务限定 2 分钟；正常的 workflow 与发布变更使用单轮 Code-Pro；瞬时会话恢复限定为一次检查点保留的恢复；使用经验证的外部发布安装 OpenCodeReview（不再使用 npm 引导，该引导仅在 OCR 资产确认缺失时临时允许）。

- 变更: 分诊与 AI 审查共享一个 FIFO 队列，移除整次审查重试；请求重试交给 OpenCodeReview，模型、提供方与密钥回退交给 AI Gateway。控制证据注入临时提交，不改变受治理的 PR head。

- 变更: AI 分诊与审查通过 `AW_IS_AI_REVIEW_ENABLED` 选择开启，确定性治理门禁不变。





- 变更: 测试包：产品测试套件集中为 Action Worker 测试包，附带共享测试工具、测试包运行器与迁移前的用例清单；`.github/test-pack.json` 作为受保护的 CI 控制路径；`docs/TEST_PACKS.md` 记录各受管仓库的状态。

- 变更: 为各受管仓库的加固行为补充测试：owner-only 凭据文件、服务器边缘的环境加载与备份保留、AdFilter 头部、delta-suite 浏览器代理、delta 网页抓取与脱敏夹具、app-source 许可证服务、ai-gateway 的 OAuth、边缘缓存、订阅与仪表盘开关。

- 变更: internal-vault 测试包同步 `cfworkers_service_deploy` 的变量与密钥处理、发布顺序、健康检查与回滚；R2 客户端配置与密钥掩码也有测试覆盖。

- 变更: 工作流不引用中央密钥、检出不持久化凭据、CodeQL 作业不接触密钥的不变量测试。

- 变更: 记录 owner 决定：组织保持免费版套餐，私有仓库保持私有；规则集只适用于四个公开仓库，私有仓库依赖 Main Write Guard（ORG-006 与 AW-002 提案）。

- 变更: 新增设计提案 AW-002（用 Environments 隔离部署与任务密钥）、AW-005（PR 可以修改自身 CI 的范围）与 ORG-006（main 分支规则集加固），均待 owner 批准，未实施。

- 变更: 新增 `SECURITY.md`（英文与中文），指向 GitHub 私密漏洞报告；备用联系人待 owner 补充。

- 变更: 文档说明门禁由确定性策略与 CI Evidence 组成。删除没有策略依据的"审查阻断阈值"项。

- 变更: 新增 `scripts/central-secret-scan.ts` 与 `policies/security.json` 中的 `secret_allowlist`，并在 CI 沙箱中使用目标仓库可信引用的 `.gitleaks.toml`。


- 变更: 工程语言门禁的检查覆盖 HTML 模板与 Hugo 注释，`*.min.*` 文件例外。


- 新增: 公开仓库的 main 与 legacy 规则集由 Action Worker 统一创建并修复漂移。

- 新增: 发布未指定版本时，Release App 从上一个 `<release-key>-v<version>` 标签之后的 Conventional Commits 计算下一个稳定版本（破坏性标记按 SemVer 规则处理）。跨度内没有可发布的提交、出现非规范标题或超过 200 个提交时失败，并在消息中给出修复方法；显式输入版本时保持原行为。清单的 `release_notes` 为空时，同一跨度生成发布说明。

- 新增: 手动部署在 `source_sha` 为空时部署默认分支当前 HEAD。

- 新增: PR 在作者或提交者名称包含 AI 代理或模型名、trailer（如 `Co-Authored-By:`）包含代理名、或标题与提交行是工具署名（如 `Generated with`）时失败。标题与提交正文中的代理名称允许出现。

- 新增: 新增 `test-driven-development`、`writing-for-agents` 与 `multi-agent-delegation` 技能；`bug-fixes` 先建立反馈回路再提出假设；PR 审查分别报告意图与标准两个维度；代理技能说明冲突指令的解决顺序（机器合同与策略优先，任务指令不能放弃它们）。

- 新增: 新增 `deploy-verify`、`flaky-test-triage`、`security-remediation`、`contract-evolution` 与 `semantic-refactor` 五个代理技能；`code-minimality` 增加"重新生成而非手工合并机器生成的锁文件"的规则，并新增代码最小化审查指南与 AI 审查规则。

- 新增: 中央 CI 派发 Release 与 Deploy 时，`requested_version` 与 `release_notes` 作为可选输入（见上文版本计算）。

- 新增: 每个发布附带许可证元数据，默认 Apache-2.0，可由应用级显式覆盖。

- 新增: 普通 PR 审查前新增 Code-Air AI 分诊，带确定性安全下限，并可跳过高置信度的低风险审查。

- 新增: 集中校验 Python、Rust 与 TypeScript 变更源码的命名。

- 新增: 集中的第三方工具同步与发布产物准备（OpenCodeReview、R Base 等）。

- 新增: 治理前预检 AI Gateway 模型访问，Agent 密钥无法调用所需审查模型时尽早失败。

- 新增: `AW_AI_AGENT_CONFIG` 集中配置可选的 AI Agent 启用与逻辑模型路由；任务运行时的 AI Agent 模型变量由此推导。审查、分诊、写作与未来代理共用一个配置来源。

- 新增: 任务源与部署源可以为密钥声明别名（`policies/task-secrets.json` 与 `policies/deploy-secrets.json` 的 `aliases`）。ai-gateway 部署的 `CLOUDFLARE_API_TOKEN` 取自 `CLOUDFLARE_API_TOKEN_SECONDARY`，internal-vault 任务 FongapBlog 与 FongapCDN 取自 `_PRIMARY`，二者使用不同的 Cloudflare 账号。

- 新增: `policies/task-secrets.json` 为 EngineSuite 项目设置密钥上限：`CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 取自 `_PRIMARY`，并允许 Algolia 与 `ENGINESUITE_*` 密钥。首次运行前须创建这些密钥。

- 新增: 中央密钥策略新增任务源的密钥上限（`policies/task-secrets.json`）；`AW_TASK_SECRET_POLICY_MODE` 可选 `warn`（默认）或 `enforce`。

- 新增: 中央 CI 扩展到所有受管业务仓库，保留项目自有的可信测试入口。

- 新增: 托管仓库可在可信执行清单的 `linux` 作业上声明 `matrix.shard`，把 Linux CI 拆分为并行分片；无分片的仓库保持原有的单作业调用。

- 新增: 经批准的薄 PR 派发器模板（运行器由中央解析，支持自托管控制配置）；安全门禁仅对与审计哈希一致的工作流豁免。

- 新增: 跟随型产品在自身文件中固定上游产品的版本或提交，上游受治理发布后移动这些固定值。发布前检查每个固定值对应已发布的上游版本；Action Worker 为每个 follower 在 `aw/follow/<product>` 上开一个 PR，只修改声明的固定文件。声明 uv 锁文件的 follower 在沙箱中刷新 `uv.lock`，且只在变更仅涉及该文件时才提交。


- 新增: 部署环境在源清单声明 `triggers.schedule` 时按 cron 计划部署。Intake 的 `deploy-schedules` 作业每 5 分钟运行一次，回看 12 小时取每个产品环境最近一次到期的触发，并以默认分支 HEAD 上的 `Deploy Schedule/<product>/<environment>` 状态记录。默认分支红色或未验证时跳过本次，不改为部署更早的提交。

- 新增: 一个仓库可部署多个产品与环境。schema 2 的部署清单按环境声明触发器（`push` 为 `true` 时监视产品根目录，`push.paths` 可列出其他路径）；无触发器的环境只能手动部署；需要必需审批人的环境被拒绝。

- 新增: 一个仓库可含多个产品，每个产品在 `projects/<name>/` 中声明发布清单，Release App 通过 `product` 输入选择；构建脚本从 `RELEASE_PRODUCT_ROOT` 读取产品根目录；不同产品的运行互不排队。

- 变更 [migration]: 同一托管产品的部署策略条目从仓库键迁移到产品键 `owner/name/product`。产品不再回退到仓库键，通过仓库键的手动部署被拒绝，直到其清单使用产品布局。


- 变更: 工具同步与发布的 Release 标签与标题规则统一：标签为 `<release-key>-v<version>`，标题为 `<release_name> v<version>`。


- 修复: 中央 Intake 在打开的 PR 修改了安全字符集以外的文件名（如非 ASCII 名称）时继续运行，不再中断对账。

- 修复: 任务派发在源 CI 缺失时会请求中央 CI，不再等待从未被请求的 CI Evidence。

- 修复: 定时任务派发与 Intake 中的请求被验证，不再因冒号格式而被拒绝。

- 安全 [security]: 删除并非必要的 `task-log-*` 制品上传，私有任务输出保留在运行器上。

- 安全 [security]: 私有仓库任务的状态与日志只以加密形式上传，并按制品名称恢复最近的成功状态，而不是扫描最近 50 次运行。

- 安全 [security]: PR 治理在等待批准时不再重复派发；只有维护者批准当前 head 后才继续。


- 安全 [security]: 日志与输出中的私有内容被掩码，私有仓库的失败只显示短哈希与提交的 7 位前缀。
