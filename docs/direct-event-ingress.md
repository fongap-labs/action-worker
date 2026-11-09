# 直连事件入口：独立部署与受控验收

本实现是 **尚未启用的源代码入口**，不是已经完成生产 Webhook E2E 的证据。它用于替代业务仓库 GitHub Actions 桥接的*实时唤醒*，而不是替代中央 Intake、Repository Policy、签名状态或 CI/Release/Deploy 门禁。

## 执行链

GitHub App `push`（仅默认分支）或 `pull_request`（opened/reopened/synchronize/ready_for_review）Webhook → 原始请求体 HMAC-SHA256 验签 → 固定安装与组织核对 → D1 持久交付 ID 与原子租约 → GitHub App 仅对控制仓库签发 `contents:write` 安装令牌 → 空载荷 `run-intake` → **现有**中央 Intake 独立读取最新 GitHub 事实并对账。Webhook 中的 SHA、PR 编号、结论、命令、Secrets 均不进入分发载荷。

入口属于独立的 Cloudflare Worker（`scripts/direct-event-ingress.ts`）；现有主分支 `intake.yml`、5 分钟轮询、业务桥接均保持不变。不能因本代码存在就删除桥接、关闭调度器或扩大权限。

## 需要受控配置的绑定

- `AW_INGRESS_DB`：专用 D1 数据库，按 `docs/direct-event-ingress.sql` 创建表和索引。不得使用内存去重替代数据库。
- `AW_GITHUB_WEBHOOK_SECRET`：独立的 GitHub App Webhook Secret（敏感）。
- `AW_GITHUB_APP_ID`、`AW_GITHUB_APP_INSTALLATION_ID`：该 App 与控制仓库所属组织的固定数字身份；必须校验安装覆盖控制仓库。
- `AW_GITHUB_APP_PRIVATE_KEY`：GitHub App PKCS#8 PEM 私钥（敏感，单独可信环境存储）。
- `AW_CONTROL_REPOSITORY`：明确固定的 `owner/repository`，不得由请求动态选择。

严禁把任意 Webhook 输入放进 `client_payload`，或将此 Worker 的 GitHub App 令牌向被测业务代码开放。此入口只具有请求 Intake 对账的能力，不触发特权执行，也不向外部源仓库写状态。

## 失败与重放

D1 将每个 GitHub `X-GitHub-Delivery`（规范 UUID）及**已签名原始请求体的 SHA-256 摘要**原子登记。GitHub 的 HMAC 不覆盖该请求头，因此相同签名请求体即使被篡改为新的 Delivery ID，也只能复用已有记录；原 Delivery ID 配上不同请求体则拒绝。每次分发前取得 60 秒原子租约；成功收到 GitHub `204` 后记录完成。租约内重复送达不得重复调用；GitHub API 失败、进程终止或「已派发但未记完成」会保留记录，**必须启用独立 scheduled Cron** 对过期租约进行扫描重试。后者可能重复触发 *Intake 唤醒*，但由既有对账/签名状态实现幂等，不能理解为业务任务恰好执行一次。

D1 故障时不得绕过入库而直接发送，令牌签发失败或 GitHub 非 `204` 必须保留待重试。应监控待处理数量、最老待处理年龄和分发失败率；对持续失败应告警，受限日志不得记录密钥、原文 Webhook 或业务私有数据。数据库历史应设置经批准的保留周期；不能直接删除未完成投递。

## 部署/验收门槛（未执行）

1. 独立审核 App Webhook Secret、安装 ID、私钥和 D1 权限，选择非生产试点及公开事件入口的网络/访问控制策略。
2. 独立创建 D1、配置 Cron 和 Worker Route，验证部署配置未产生新的 Secret 泄漏入口。
3. 使用真实 GitHub App 交付证明：有效签名可唤醒中央 Intake；伪造签名、非组织事件和不支持的事件不得派发；重放同一 delivery ID 不重复派发。
4. 注入 GitHub API 失败与 D1 故障，验证持久待处理、Cron 恢复、租约竞争及下游状态对账；测试桥接中断时仍可自主唤醒。
5. 保持既有桥接/定时兜底，在独立审查实际运行证据后决定是否切流。不得在当前代码 PR 中开启生产 Webhook Route 或迁移 Secrets。

当前 `npm run check` 的单测只覆盖源码层 HMAC/源约束/交付去重/恢复合同。它们不能替代受控部署与真实 Webhook E2E。
