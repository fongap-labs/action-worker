# 更新日志

## [Unreleased]

- 修复: 完全撤销 delta-legacy 的 Action Worker 管理授权；保留排除名单，并让仓库接入器拒绝排除项与授权同时存在的矛盾配置。

- 修复: Action Worker 控制仓库自身的 PR 在六项 CI 汇总门禁全部通过后自动使用受限 GitHub App 按精确 HEAD squash 合并；草稿、Fork、SHA 或基线变化一律阻断，不再要求人工合并或独立审查。

- 修复: 私有仓库 GitHub Free 计划不支持原生 Auto-merge 时，仅对该能力限制容忍设置读回差异，保留其余仓库设置与中央签名合并门禁；同仓库官方 fongap-bot PR 可不经独立审查进入 CI，其他 Bot 与 Fork 仍需可信准入。

- 新增: fongap-labs 9 个受管仓库统一启用自动合并（归档用途的 delta-legacy 排除在外）；仅在中央签名 CI Evidence、PR Governance 与 validate-merge 全绿且精确 PR HEAD 未变化时自动 squash 合并，草稿和失败检查保持阻断，独立审查不再作为合并条件。

- 修复: Audit-Code 端点探测对短期限流作有界退避，OCR 仅在明确短期限流时恢复会话。

- 修复: AI Gateway 部署及一次性健康密钥初始化统一从 `ai-gateway-ops` Environment 读取现有 `CLOUDFLARE_API_TOKEN_SECONDARY`，逻辑发布目标仍为 `production`；运维工作流、中央凭据路由、只读审计与回归测试同步。此更正替代先前错误的 `CLOUDFLARE_API_TOKEN_OPS` 或 `production` 凭据绑定，保留原有失败关闭、独立管理员权限和健康验证，不复制或旋转 Cloudflare Token。

- 修复: AI Gateway 部署变量校验拒绝未知的 Secret、Token、Key 和凭据命名，避免敏感变量进入普通部署注入。
- 新增: AI Gateway 非敏感部署变量统一由受保护的 ai-gateway-ops 提供，拒绝仓库级回退。

- 修复: AI Gateway 文档治理合同按明确拒绝 `budget_split` 和跨 Tier 加权分配的语义校验中英文声明，不再因现有中文文档缺少固定英文句式使中央 CI 失败；未知预算模式继续拒绝。

- 修复: 离线部署密钥作用域审计按中央凭据路由核对实际 `ops` Environment，而非逻辑 `production` 名称；新增错误 Environment 中同名 Secret 不可达的回归测试。

- 修复: 真实受保护初始化 #42739655070 证明 `ai-gateway-ops` 缺少 Cloudflare ops Token；恢复原有 `production` 部署 Token 绑定，同时新增单独只读 `ai-gateway-ops` Job 输出经校验的 Account ID 和公网 Origin。健康密钥仅向实际凭据作业 Environment 初始化，并使用现有受保护 Cloudflare 部署身份发布和检查健康；无跨 Job Secret 传递、不向 ops 复制凭据。

- 修复: Task Account ID 名称审计识别 Repository 与已授权 Organization 的重复定义；部分元数据不可读时仅在已证实两个同名来源后报告重复，其余保持未验证，不读取值、不改配置。

- 修复: 定期配置审计检测四个 Task 的 Account ID 重复与缺失来源，权限未知保持未验证；无自动配置改动。

- 修复: AI Gateway 中央部署禁用合同改用真实 Bash 退出码验证，取消要求未执行部署成功退出的过时断言；保留既有安全门禁。

- 修复: 未启用的 GitHub App 直达事件入口增加 D1 原子重试计数、指数退避和五次上限；失败耗尽后持久隔离并输出脱敏指标，不再无限重复派发或将重放误报成功，现有桥接和生产配置不变。

- 修复: 受保护 ops 作业成功完成生产发布后，改为以工作流限定的 GitHub Deployments 写权限直接记录成功状态，避免纯审计 Job 被 production Environment 人工审核规则阻塞；实际部署、固定源码、密钥隔离与门禁不变。

- 治理: 私有任务隔离证据验收按真实单人维护模式复核，移除不存在的第二名人工审核依赖；保留八项技术门禁、真实历史状态恢复、互斥与受保护发布验证要求。

- 安全: 中央部署 prepare 以现有只读 GITHUB_TOKEN 校验凭据 Environment 已存在且元数据完整；缺失或无权限时拒绝进入动态 Environment Job，防止自动创建未经保护的环境。保留人工审批及原有 Secret 隔离。

- 安全: FongapCDN 已由中央策略强制走受保护部署，撤销中央通用 Task Secret 授权，增加跨执行模式的凭据准入一致性测试，其他项目任务授权不变。

- 安全: 自动推送与定时部署在派发前校验受中央策略选中的实际凭据 ops Environment 是否需要人工审核，避免只检查逻辑 production 而使无人值守发布卡在审批队列；不可读取及未经授权均拒绝派发。

- 安全: FongapCDN 转入受保护部署后，由中央任务准入策略拒绝旧固定源码 SHA 的普通任务执行，防止旧 run-task 入口绕过源仓库删除的 task.json；其余普通任务保持不变。

- 优化: 将独立的产品生产部署凭据作用域纳入 Action Worker 中央控制策略，FongapCDN 正式发布在受保护 internal-vault-ops 中使用既有 PRIMARY Cloudflare 凭据，经过源码准入与 CI 后执行，不跨 Job 传递 Secret，并由独立 production Job 补记部署审计；其他产品保持原有 production 路径。

- 修复: 通用任务分发对内部仓库批准的 Cloudflare 账号非敏感 Variable 增加受保护 internal-vault-ops 精确作用域读取及任务 Job 安全传递，仓库级可见时直接复用、仅在不可见时启用运维作业；严格绑定中央项目白名单、不跨 Job 传 Secret、不放宽私有隔离或准入门禁。

- 修复: 控制仓库受保护配置审计在 Environment Secret 名称接口被明确拒绝时，继续读取有权限访问的 ops Variables 元数据；不可读取的 Secret 范围标为未知，并与组织/环境整体不可读取的自动降级链衔接，避免配置误判与重复人工盘点。

- 修复: 组织配置作用域自动审计在 Organization 和 Environment 元数据均被 GitHub 403 拒绝时，继续只读核验 Action Worker 仓库级元数据，明确将无法访问的环境/继承统计标为 null 而非零；不要求运维重复配置凭据，也不改变任何作用域或密钥值。

- 修复: 组织级 Secret/Variable 元数据读取被 GitHub 拒绝时，自动降级审计 Action Worker 控制仓库的已有 ops Environments，输出明确的部分覆盖标识，将无法核验的组织继承及遮蔽计数置为 unknown 而不是误报为零；不新增高权限 Token。

- 修复: 组织级配置元数据审计失败时仅报告组织/仓库/Environment 访问层级和脱敏 HTTP 错误类别，不泄漏私有仓库、Secret 名称、变量值或原始响应，缩短权限问题定位路径。

- 新增: Action Worker 在受保护的 admin-ops 内自动执行组织级配置元数据作用域审计，复用既有管理员身份，仅提取仓库/组织/Environment 的 Secret 与 Variable 名称，丢弃 Variables API 响应中的值、不记录也不迁移凭据；审计目标自动包含新接入的授权仓库，不再依赖第二份名单人工同步。

- 修复: 由 Action Worker 已有 ai-gateway-ops Environment 统一提供 AI Gateway 的 Cloudflare 账户 ID、公开 HTTPS 地址、KV/D1 标识及 Analytics 数据集等非敏感 Variables，安全传给受保护的生产部署；可选值未配置时保留现有来源，冲突和越权均拒绝，Secret 绝不跨 Job 输出。

- 修复: AI Gateway 的 Cloudflare Secondary Account ID 从 Action Worker 现有 ai-gateway-ops Environment 按最小作用域读取，经只读非敏感输出交给受保护生产部署；不跨境传递密钥，不影响其他产品，缺失与冲突时拒绝部署。

- 修复: 还原 AI Gateway 健康密钥初始化的 Cloudflare 运维作业至 Action Worker 已有 ai-gateway-ops Environment，撤销将运维凭据错误绑定到 production 的变更；保留受保护 admin-ops 管理域与不覆盖已有密钥的限制。

- 修复: 一次性健康密钥引导复用受保护 production 部署链已批准的 Cloudflare Secondary 凭据映射，避免依赖尚未配置的独立运维账户；保留管理员域生成、双 Environment Secret 保存、Worker 写入前存在性核验及实际健康检查。

- 修复: 首次 fongap-bot 请求因 GitHub App 尚未获 Secrets 写权限而被拒绝后，改以现有受保护 admin-ops 凭据写入两个 GitHub Environment，再由 ai-gateway-ops 从最新 Environment Secret 快照部署同一随机健康密钥到 Cloudflare；保留三处独立名称预检、非覆盖及真实健康检查。

- 修复: 独立 PR AI Review 工作流向 CI Evidence 等待器传入必需的 PR 编号，避免参数错误导致证据收集在启动时失败；同时增加主 PR 治理与审查工作流的入参合同测试。

- 新增: 部署 Secret 的固定源码与当前 Environment 名称作用域离线只读审计，拒绝读取凭据值与未受审的生产配置变更。

- 测试: 将直连事件入口的模拟非生产配置及固定版本 Wrangler 离线打包纳入中央静态 CI，验证 Worker 可编译且不触发部署。

- 修复: 任务必需 Variable 校验读取已导出的作业环境，避免解析器传入空环境导致可用变量被误报缺失；新增独立命令行回归测试。

- 新增: 直连 Webhook Cron 输出本轮失败重试次数，区分持续分发失败和单纯积压，并验证仅记录脱敏聚合数据。

- 新增: 直连 Webhook Cron 每轮重试后输出脱敏积压指标（待处理数、最老待处理分钟数、本轮完成数），并以生产同款 SQLite SQL 验证无敏感信息泄漏。

- 修复: 直连 Webhook 的 GitHub App JWT 与安装令牌出站请求禁止 HTTP 重定向，避免认证请求跳转至未授权端点。

- 测试: 增加真实 SQLite/D1 语句驱动的直连 Webhook 集成回归，覆盖 HMAC 验签、重放去重、原子租约及 Cron 失败恢复。

- 修复: npm 发布分发在使用本地 GitHub App Action 前安全检出源码，避免缺失 action.yml。

- 修复: SBOM 下载遇到暂时网络故障时有限重试，保留生成验证和强制失败门禁。

- 修复: 部署凭据采用独占文件句柄，在首字节写入前登记清理所有权，防止部分写入失败时留下 Secret 文件，并验证既存符号链接不可覆盖。

- 修复: 部署 Secret 写入中途失败时仅清理由本次尝试新建的敏感文件，保留预先存在的路径并继续拒绝缺失的必需槽位。

- 维护: 更正运维手册中两阶段 Release 已默认启用及所有失败可自动删草稿的过时描述，明确当前只读发布和受控试点门禁。

- 修复: 部署必需 Secret 在全部槽位验证成功前不写入任何临时文件，并拒绝伪造或重复的文件名，降低失败部署时的敏感落盘风险。

- 维护: dsh-plugin 插件发布必须通过手动工作流明确填写版本，拒绝自动计算和自动分发入口。

- 新增: 对 Actions Variable 的离线只读名称和作用域审计，在固定源码 SHA 和受管槽位约束下输出脱敏计数，不改变必需配置注入或绕过失败门禁。

- 修复: 非生产两阶段发布在阶段一受管 PR 已合并后，只允许严格的单提交、纯 CHANGELOG 变更及本次版本证明通过的旧来源 SHA 安全恢复。

- 修复: GitHub Release 正式发布请求一旦发起，不再因响应丢失而自动删除可能已发布的 Release；保留现场由受控运维核对。

- 修复: 两阶段非生产 Release 以受管合并后的 CHANGELOG 作为发布说明权威来源，manifest 自带说明不一致时拒绝发布。

- 修复: 两阶段发布在复用已合并变更日志 PR 时，要求版本和已合并条目与当前 Release manifest 一致，拒绝旧请求的错误发布依据。

- 新增: 为两阶段 Release 阶段一提供默认关闭、空白名单、独立 PR 写与状态读凭据限定的非生产接线路径，不改变生产只读发布行为。

- 修复: 两阶段 Release 的合并等待和 Main Write Guard 使用同一截止时间，并在打开 PR 前拒绝无效轮询与超时配置。

- 修复: 两阶段 Release 恢复已有 PR 时核验标题、源仓库、目标分支与发布标签，防止错误合并提交被用作发布依据。

- 修复: 直连 Webhook 在 D1 入库前验证 PKCS#8 DER 可导入性，并限制两次 GitHub API 调用的响应时限，避免失效密钥污染队列或出站请求超出租约。

- 修复: 定时任务及部署回执历史按有序可信时间戳安全截断，保留签名去重并将枚举硬上限收敛为每提交五千条，避免活跃状态历史导致总控长期拒绝派发。

- 新增: 为 GitHub App 直连入口提供默认无路由、无预览 URL、无 Cron、无明文密钥的离线非生产 Wrangler 配置生成与合同测试。

- 修复: 直连 Webhook 在存储投递前拒绝 GitHub 默认 PKCS#1 私钥，明确 PKCS#8 离线转换及脱敏验收要求。

- 修复 [security]: 直连 GitHub Webhook 对未签名的事件类型请求头增加消息结构和 PR 目标身份交叉验证，防止不同事件被换头冒充有效唤醒。

- 修复: 中央 AI Gateway 物理尝试用量与 TTFT 合同跟随 Gateway-owned 源码拆分，旧路径必须只保留兼容导出，维持真实行为断言。

- 修复: 私有任务加密工件测试不再把随机密文中的短数字误判为明文泄漏，保留格式与解密完整性断言。

- 维护: 为直连 Webhook 投递表增加原生 SQLite 合同测试，校验去重约束、原子租约与公平排序。

- 修复: 直连 Webhook 过期投递按租约先后公平重试，阻止旧安装 ID 在配置变更后签发令牌。

- 修复 [security]: 将 GitHub Webhook 防重放绑定到已签名请求体摘要，拒绝换用 Delivery ID 重新派发。

- 新增: 引入独立 GitHub App Webhook 入口、HMAC 验签与 D1 持久去重重试，仅唤醒中央 Intake，尚未启用生产接入。

- 维护: 修正发布指南中的健康检查密钥说明，明确 `AIG_DEPLOY_HEALTH_KEY` 是独立凭据，不能复用 `AIG_ACCESS_KEY_AGENT`。

- 修复: 定时任务与部署先写入签名预留回执再派发，防止派发结果不明时自动重复请求；明确失败需人工核对后恢复。

- 修复: AI Gateway 尝试预算测试跟随旧 Provider 执行模块迁移，同时验证两中心预算。

- 修复: AI Gateway fallback 容量测试读取实际 Gateway 所有权模块，兼容源文件未迁移和兼容导出两种布局，保留 Tier 1 maxInFlight 断言。

- 修复: AI Gateway 中央测试按实际运行模块选择 Gateway 预检源码，兼容原 src 路径与拆分后的 apps/gateway，继续验证路由、仪表盘及 RPM 豁免语义。

- 修复: 定时任务和部署使用 GitHub 完整提交状态历史验证已签名的旧时段派发回执，不再依赖仅保留上下文最新状态的合并视图；历史扫描分页且超限拒绝危险重放。

- 修复: 定时任务与部署的签名派发去重遍历有界 GitHub 提交分页，避免提交量超过 100 条时遗漏已有派发记录；超过安全上限则拒绝潜在重复派发。

- 调整: 私有 Windows CI 的数字化失败诊断采用中央授权策略白名单，移除沙箱内按仓库名判断的特例，维持原有私有日志隔离。

- 修复: 中央 CodeQL 任一分析失败时阻断受保护 SARIF 发布，禁止发布不完整安全扫描结果。

- 修复: 安全扫描的受保护 SARIF 发布作业从可信控制仓库目录读取授权策略，修复工作目录不匹配导致的发布失败。

- 新增: 从 fongap-bot GitHub App 自动发现组织仓库，新建合格仓库只授予 PR 治理，通过原有 validate-merge 自动合并接入 PR。
- 调整: 由 policies/repository-access.json 作为仓库权限唯一来源，取消 AW_REPOSITORY_POLICY 变量对运行时权限的控制，保留现有九仓库授权不变。

- 调整: 单人维护的 Action Worker 仅在维护者明确同意后才修改门禁，不额外新增人工审批工作流或第二套 Ruleset。

- 修复: 公开受管仓库的 main 强制门禁绑定 fongap-bot 作为 validate-merge 唯一可信发布来源，保留 GitHub 原生分支保护与中央来源审计。

- 新增: 为受管桌面应用发布增加 macOS 15 ARM64 沙箱构建 Runner，保持独立平台构建与发布门禁。

- 修复: AI Gateway 生产部署的健康密钥不再别名至 AGENT 访问密钥；运维 Secret 写入改用 Cloudflare Secrets API，禁止占位 Worker 覆盖代码。

- 修复: 复用独立 Environment Secrets 进行动态逐项注入，避免要求运维迁移 JSON 密钥包；保持现有 Cloudflare Worker 运行时密钥隔离。

- 修复: AI Gateway 中央合同测试验证 Cloudflare 运行时密钥持久保存、生产部署密钥范围收敛及禁止明文密钥上传。

- 修复: 部署工作流改为动态选择产品密钥包，隔离共享环境中的其他产品凭据。
- 新增: 按产品维护部署密钥包，中央执行器只向源脚本传递本次获准的密钥。

- 修复: MCP Hub 中央部署改为共享 production，并移除所有运行时业务密钥的部署授权。

- 新增: 允许 MCP Hub 部署按需接收独立的 Runtime 派发密钥。
- 修复: AI Gateway 生产部署密钥上限收敛为 Cloudflare 发布凭据与健康检查别名，Provider/Tier/OAuth/中心认证密钥不再进入部署作业。
- 新增: 增加受保护的 ai-gateway-ops 工作流，支持 Cloudflare Worker Secret 名称盘点、单项更新与健康检查；更新失败即失败关闭。
- 修复: 部署健康检查改用独立的 AIG_DEPLOY_HEALTH_KEY，不再把 AIG_ACCESS_KEY_AGENT 暴露给 production 部署作业。
- 修复: 阻止 AIG_DEPLOY_HEALTH_KEY 与用户访问组密钥复用，并要求 URL 安全随机格式。
- 修复: 自动发布遇到待维护者审批的合成 PR 时继续限时等待，审批后重新触发中央门禁。
- 修复: 私有任务在日志遮蔽后以事件内容恢复身份，使用不可逆项目指纹保持队列隔离。
- 修复: 可信任务源校验注入签名密钥环，确保重跑 CI 后的证据仍按密码学校验。
- 修复: 任务执行与发布凭据隔离到独立运行器，使用绑定请求身份的加密产物传递。
- 新增: 受保护单次验收通过目标 PR、中央 CI 证据和合并门禁发布合成测试产物。
- 新增: AI Gateway 图片生成鉴权、模型隔离和三类 Provider 契约测试。

- 新增: 受保护预检校验真实私有任务源发布策略和 external-vault 单仓库写入权限。
- 新增: 受保护主分支自动验证真实密钥加密产物跨独立运行器传递及请求身份拒绝。
- 新增: 在可信控制层提供独立的任务产物加密封装和密钥配对模块。
- 修复: 发布密钥预检增加受保护的单目标 GitHub App 写入权限与范围验证。
- 修复: 发布密钥配置说明或生成器修改后自动检查受保护密钥对。
- 修复: Action Worker 机器人创建的主分支事故参与去重和阻断，防止事故遗漏与重复开单。
- 修复: 历史主分支写入事故不再自动过期或自动关闭，须经明确的人工处置。
- 修复: Gitleaks 固定版本下载增加校验与重试，短暂状态写入错误执行有限重试。
- 新增: 支持 beta 预发布、正式版汇总和多种工具版本格式。
- 新增: 支持 npm 发布、补发及多产品独立发布记录。
- 新增: 支持使用 GitHub App 按仓库签发最小权限的临时令牌。
- 新增: 增强中央任务、环境密钥授权与受管部署能力。
- 修复: 修复 CI 取消、超时或重复调度后状态长期挂起的问题。
- 修复: 修复 CI 证据与主分支来源证明可能误判或被新状态遮蔽的问题。
- 修复: 修复 GitHub API 限流与权限错误混淆导致的错误诊断。
- 修复: 修复工具同步、镜像发布、版本解析与发布并发中的异常。
- 修复: 发布资产校验通过后才创建正式 Release 与标签，避免遗留无效标签。
- 修复: 修复 PR 审查、中央 CI 和部署对读取权限的错误依赖。
- 修复: 修复私有任务及 CI 诊断信息可能泄露到公共日志的问题。
- 修复: 中央密钥扫描改用可信的固定版本，异常失败时保留脱敏诊断。
- 修复: 过期运行不再阻断新的 PR 治理和部署。
- 维护: 统一跨仓库治理、凭据分流和工作流调度边界。
- 维护: 变更记录改为单一 CHANGELOG 文件，仅采用三类中文条目。
- 维护: 治理文档二三级标题统一使用中文。
