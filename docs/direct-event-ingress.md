# 直连事件入口：独立部署与受控验收

本实现是 **尚未启用的源代码入口**，不是已经完成生产 Webhook E2E 的证据。它用于替代业务仓库 GitHub Actions 桥接的*实时唤醒*，而不是替代中央 Intake、Repository Policy、签名状态或 CI/Release/Deploy 门禁。

## 执行链

GitHub App `push`（仅默认分支）或 `pull_request`（opened/reopened/synchronize/ready_for_review）Webhook → 原始请求体 HMAC-SHA256 验签，并核对不在签名范围内的 `X-GitHub-Event` 与签名请求体结构一致（push 必须具备有效 before/after SHA；PR 必须具备一致的编号及目标仓库身份） → 固定安装与组织核对 → D1 持久交付 ID 与原子租约 → GitHub App 仅对控制仓库签发 `contents:write` 安装令牌 → 空载荷 `run-intake` → **现有**中央 Intake 独立读取最新 GitHub 事实并对账。Webhook 中的 SHA、PR 编号、结论、命令、Secrets 均不进入分发载荷。

入口属于独立的 Cloudflare Worker（`scripts/direct-event-ingress.ts`）；现有主分支 `intake.yml`、5 分钟轮询、业务桥接均保持不变。不能因本代码存在就删除桥接、关闭调度器或扩大权限。

## 需要受控配置的绑定

- `AW_INGRESS_DB`：专用 D1 数据库，按 `docs/direct-event-ingress.sql` 创建表和索引。不得使用内存去重替代数据库。
- `AW_GITHUB_WEBHOOK_SECRET`：独立的 GitHub App Webhook Secret（敏感）。
- `AW_GITHUB_APP_ID`、`AW_GITHUB_APP_INSTALLATION_ID`：该 App 与控制仓库所属组织的固定数字身份；必须校验安装覆盖控制仓库。
- `AW_GITHUB_APP_PRIVATE_KEY`：**PKCS#8、未加密 PEM** 的 GitHub App 私钥（敏感，单独可信环境存储）。GitHub 官方下载的是 **PKCS#1** RSA 私钥；直接使用下载文件会在 WebCrypto 签名时失败。入口在任何 D1 写入和 GitHub API 请求前拒绝未转换的密钥格式。 PEM 头尾与 Base64 字符合法也未必代表 DER 可用；入口对经 HMAC 验证且受支持的事件先执行 WebCrypto `pkcs8` 导入验证，导入失败时不登记投递、不签发 App 令牌、不泄漏密钥材料。

只在授权的离线可信终端进行格式转换，勿在 CI、日志、Issue、PR 或终端输出中暴露密钥：

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in /secure/github-app-original.pem \
  -out /secure/github-app-pkcs8.pem
chmod 600 /secure/github-app-pkcs8.pem
```

对照 GitHub App 设置的公钥指纹独立核验密钥匹配，再使用受控 Secret 管理渠道保存转换后的 PKCS#8 PEM。不要把原始或转换后的 PEM 添加到仓库、配置文件或工作流输入；按授权密钥处理流程处置转换中间文件。源码的格式校验不等于已证明密钥与 App 身份匹配，后者仍需非生产真实 GitHub API 验收。
- `AW_CONTROL_REPOSITORY`：明确固定的 `owner/repository`，不得由请求动态选择。

严禁把任意 Webhook 输入放进 `client_payload`，或将此 Worker 的 GitHub App 令牌向被测业务代码开放。此入口只具有请求 Intake 对账的能力，不触发特权执行，也不向外部源仓库写状态。两次携带 App JWT/安装令牌的 GitHub API 请求都必须设置 `redirect: "error"`：任何重定向都视为出站失败并保留已登记的 D1 重试记录，避免携带认证信息的请求跳转至非预期端点。

## 非生产离线配置生成（未部署）

`npm run ingress:staging-config` 在**本地受控终端**读取 `AW_INGRESS_DATABASE_NAME`、`AW_INGRESS_DATABASE_ID`、`AW_GITHUB_APP_ID`、`AW_GITHUB_APP_INSTALLATION_ID` 四个获批标识，生成忽略提交的 `.direct-ingress-staging.wrangler.json`（仅含非 Secret 标识，0600 权限，拒绝覆盖已有文件）。缺少、格式非法的标识会拒绝生成。固定 Worker 名为 `action-worker-direct-ingress-staging`，固定中央仓库为 `fongap-labs/action-worker`。

生成配置默认设置 `workers_dev: false`、`preview_urls: false`、`routes: []` 和 `triggers.crons: []`，因此**不提供对外 Webhook URL，也不自动运行 Cron**。只声明源码入口与 `AW_INGRESS_DB` 专属 D1 绑定，不自动开通数据库、注册 GitHub App 或上传 Secrets；不会写入 `AW_GITHUB_WEBHOOK_SECRET`、`AW_GITHUB_APP_PRIVATE_KEY`、Cloudflare API Token 或账户凭据。该模板仅用于受控准备与离线检查，不能直接证明真实事件端到端可用。

配置生成后，可以在授权环境运行不上传 Worker 的编译检查：

```bash
npx wrangler deploy --dry-run --config .direct-ingress-staging.wrangler.json
```

受控 E2E 仍需独立审批并依次完成：创建/核验非生产 D1；在该数据库执行 `docs/direct-event-ingress.sql`；使用授权 Secret 渠道配置 Webhook Secret 和已转换的 PKCS#8 App 私钥；核实 GitHub App 最小权限和安装覆盖控制仓库；**经独立审批**才开启非生产可达 Route 与 Cron；用真实有效/伪造/重放事件及断网故障验证中央 Intake 对账并采集审计证据。先保留原有桥接与五分钟扫描兜底。

> 禁止从生成的模板直接启用生产路由、生产数据库、生产密钥或生产 Cron。Cloudflare 上传/配置和 GitHub App 安装不包含在本源码 PR 的授权范围内。

## 失败与重放

D1 将每个 GitHub `X-GitHub-Delivery`（规范 UUID）及**已签名原始请求体的 SHA-256 摘要**原子登记。GitHub 的 HMAC 不覆盖该请求头，因此相同签名请求体即使被篡改为新的 Delivery ID，也只能复用已有记录；原 Delivery ID 配上不同请求体则拒绝。每次分发前取得 60 秒原子租约；访问 GitHub App 安装令牌端点及发出 `run-intake` 的两次出站 API 调用各设 15 秒中止期限（包括令牌响应体读取），避免正常网络阻塞跨越租约界限；成功收到 GitHub `204` 后记录完成。超时或响应丢失仍视为**可能已被接收**，保留持久待处理记录并按既有 Cron 恢复，不能假设恰好一次。租约内重复送达不得重复调用；GitHub API 失败、进程终止或「已派发但未记完成」会保留记录，**必须启用独立 scheduled Cron** 对过期租约进行扫描重试。Cron 每次最多处理 25 条，按最早可重试租约、再按创建时间排序，使从未尝试的投递优先于早期反复失败的投递，避免重试队列头部阻塞；过期租约仍按原语义重试。历史待处理记录仅允许其原固定 GitHub App 安装身份再次派发：若运维已迁移或撤销安装，旧记录拒绝跨安装签发令牌，并需受控人工清理/重新对账。后者可能重复触发 *Intake 唤醒*，但由既有对账/签名状态实现幂等，不能理解为业务任务恰好执行一次。

D1 故障时不得绕过入库而直接发送，令牌签发失败或 GitHub 非 `204` 必须保留待重试。Cron 每轮重试后使用同一 D1 库的只读聚合 SQL 输出一行脱敏 JSON：`completed_count`（本轮成功派发数量）、`failed_count`（本轮已尝试但分发失败的数量）、`pending_count`（仍未完成的记录总数）、`oldest_pending_age_minutes`（最老待处理年龄，空队列为 null）；不记录 delivery ID、来源仓库、请求体、App JWT、安装令牌、Webhook Secret 或私钥。**积压指标不代表下游业务执行成功或 GitHub 恰好一次送达**；可据此建立外部阈值告警，真实告警、失败率、Cron 调度及持久保留周期仍待受控部署验收。应监控待处理数量、最老待处理年龄和分发失败率；对持续失败应告警，受限日志不得记录密钥、原文 Webhook 或业务私有数据。数据库历史应设置经批准的保留周期；不能直接删除未完成投递。

## 部署/验收门槛（未执行）

1. 独立审核 App Webhook Secret、安装 ID、私钥和 D1 权限，选择非生产试点及公开事件入口的网络/访问控制策略。
2. 独立创建 D1、配置 Cron 和 Worker Route，验证部署配置未产生新的 Secret 泄漏入口。
3. 使用真实 GitHub App 交付证明：有效签名可唤醒中央 Intake；伪造签名、非组织事件和不支持的事件不得派发；重放同一 delivery ID 不重复派发。
4. 注入 GitHub API 失败与 D1 故障，验证持久待处理、Cron 恢复、租约竞争及下游状态对账；测试桥接中断时仍可自主唤醒。
5. 保持既有桥接/定时兜底，在独立审查实际运行证据后决定是否切流。不得在当前代码 PR 中开启生产 Webhook Route 或迁移 Secrets。

`npm run check` 除模拟 GitHub/D1 接口的合同测试外，还使用 Node 内置 SQLite 执行 `docs/direct-event-ingress.sql` 与生产同一组 SQL 语句，验证唯一约束、原子租约、完成回执和有界公平排序。 新增的本地集成回归还把签名 GitHub Webhook 请求、原生产 SQL、安装令牌/API 分发模拟和 Cron 重试串联验证，以发现独立 Mock 与 SQL 测试之间的接线偏差。这仅证明本地 SQLite 语义，**不等于 Cloudflare D1 部署或真实 Webhook E2E 已通过**。
