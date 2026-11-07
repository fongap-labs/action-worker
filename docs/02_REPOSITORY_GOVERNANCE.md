# 仓库治理规范

## 1. 仓库设置

所有受管仓库使用中央默认设置。

### ❌ 错误做法 / 反面教材

各仓库手动维护不同的合并方式。

```text
项目甲：允许合并提交
项目乙：允许变基合并
```

### ✅ 正确做法 / 规范范例

从唯一策略文件统一下发。

```text
policies/repository.json
  → 禁用合并提交与变基合并
  → 启用压缩合并与合并后删除分支
```

## 2. 应用权限

共享设置仅由中央授权写入。

### ❌ 错误做法 / 反面教材

使用普通控制令牌修改设置。

```text
AW_CONTROL_TOKEN → 修改仓库设置
```

### ✅ 正确做法 / 规范范例

使用独立管理凭据，缺失即失败。

```text
AW_ADMIN_TOKEN → 应用 policies/repository.json
```

合并前只读预览：

```bash
node scripts/apply-repository-settings.ts <owner/name> true
```

## 3. 合并门禁

仅中央检查有权批准合并。

### ❌ 错误做法 / 反面教材

用智能体审查或本地状态代替门禁。

```text
人工评价通过 → 直接合并
```

### ✅ 正确做法 / 规范范例

全部确定性证据成功后才合并。

```text
安全校验 + 中央持续集成证据 + 合并请求策略
                  ↓
            validate-merge
                  ↓
                合并
```

被取消或过期的运行不得冒充成功证据。

公开业务仓库的 `main` 要求 `validate-merge` 来自 `fongap-bot`（App ID `5609149`）。Action Worker 自身的 `validate-merge` 是 GitHub Actions 自检（App ID `15368`），由同一份策略在应用时识别，不能错误锁定为业务仓库的机器人。GitHub 负责合并前拦截，中央审计不能替代平台硬门禁。

## 4. 平台保护

平台保护不可用时仍执行中央规则。

### ❌ 错误做法 / 反面教材

把提醒标签当作平台强制保护。

```text
merge-blocked 标签 → 已禁止合并
```

### ✅ 正确做法 / 规范范例

区分写入前保护与写入后隔离。

```text
公开仓库 → 原生保护 + 中央门禁 + 主分支来源审计
私有仓库 → 中央门禁 + 主分支来源审计
```

免费组织的私有仓库可能缺少强制分支保护。任何未经证明的主分支提交不得进入发布或部署链。

## 5. 规则修改

控制仓库门禁修改必须经人工批准。

### ❌ 错误做法 / 反面教材

由 Agent 或机器人修改规则并自行批准合并。

```text
Agent 修改门禁 → 自动审核通过 → 自动合并
```

### ✅ 正确做法 / 规范范例

Action Worker 是单人维护仓库，不要求第二人审核 PR。控制仓库合并时，除原有 `validate-merge` 外，GitHub 还强制要求 `Control Owner Approval`。该状态仅由受保护 `main` 上的手动工作流发布：`fongap` 指定 PR 编号及最新完整 SHA，在 `control-plane-approval` 环境亲自点击批准后，工作流验证 GitHub 的真实批准记录、身份及当前 PR SHA，才能给该提交发布成功状态。修改 PR 后必须对新 SHA 重新确认。业务仓库仍由中央 CI 自动治理。

```text
控制仓库 PR → CI 通过 → 本人在 Actions 确认 PR + SHA → 环境批准 → 合并
```

GitHub 仓库的 Settings → Environments → `control-plane-approval` 必须配置 Required reviewers 为 `fongap`，且不启用 Prevent self-review，也不允许管理员跳过保护规则。若尚未配置，工作流会因缺少真实批准记录而失败，不能当作通过。该环境无需配置或下发任何密钥。

策略、测试、文档必须同时更新。

### ❌ 错误做法 / 反面教材

直接在单仓库修改共用规则。

```text
业务仓库设置 → 新增全局合并例外
```

### ✅ 正确做法 / 规范范例

只修改中央权威及相应测试。

```text
policies/repository.json
  → 治理合同测试
  → docs/02_REPOSITORY_GOVERNANCE.md
```

不得创建第二套仓库治理规则；主分支证明详见 `07_MAIN_WRITE_GUARD.md`。
