# 受管仓库接入规范

## 1. 仓库职责

业务仓库不得复制中央执行系统。

### ❌ 错误做法 / 反面教材

在每个仓库运行完整治理链。

```text
业务仓库 → 本地持续集成 → 本地审查 → 本地发布
```

### ✅ 正确做法 / 规范范例

项目保留源码、测试、脚本及薄入口。

```text
业务仓库事件 → 通知桥接 → Action Worker
                            → 中央校验和执行
```

项目仍拥有项目架构、执行清单及不能外置的专属测试；共用测试归 `TEST_PACKS.md` 管理。

组织仓库权限的唯一权威是 `policies/repository-access.json`。已安装的 `fongap-bot` 定期查询 GitHub App 安装清单，为创建时间符合策略、默认分支为 `main`、非归档且非 Fork 的新仓库自动创建只含 `pr` 的接入 PR。该 PR 只能修改权威权限文件，并且必须通过现有 `validate-merge` 才能自动合并；任务、正式发布、部署权限仍需维护者明确授权。

要让未来新增仓库真正免手动授权，**唯一一次 GitHub 管理操作**是将 `fongap-bot` 的组织级 GitHub App 安装范围由 `Only select repositories` 调整为 `All repositories`。这不会绕过 Action Worker 的能力授权：安装可见性仅用于发现，新的能力默认仍只有 `pr`。如继续使用选定仓库模式，自动接入仅覆盖该 App 已被授权访问的仓库。

自动登记并不代表自动通过 CI：项目仍应提供真实构建/测试执行清单，缺失时保持门禁失败，不能用空测试代替。

## 2. 执行请求

请求只提交身份与目标。

### ❌ 错误做法 / 反面教材

传入凭据、主机或预设结论。

```json
{"token":"secret","runner":"self-hosted","approved":true}
```

### ✅ 正确做法 / 规范范例

中央重新验证真实提交与权限。

```json
{
  "schema_version": "1",
  "request_id": "task-123",
  "repository": "fongap-labs/example",
  "source_sha": "0123456789abcdef0123456789abcdef01234567",
  "operation": "ci"
}
```

合并请求编号只能作为定位信息，不得代替服务器重新查询的真实状态。

## 3. 执行清单

项目声明需求，不指定中央权限。

### ❌ 错误做法 / 反面教材

把具体运行器和密钥写入清单。

```json
{"runner":"self-hosted","token":"secret","bypass_gate":true}
```

### ✅ 正确做法 / 规范范例

版本受控文件只写抽象要求。

```json
{
  "schema_version": "1",
  "operations": {
    "ci": {
      "jobs": [{
        "id": "linux",
        "runner_profile": "linux-standard",
        "command": ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}"],
        "timeout_minutes": 180,
        "capability_requests": ["source.read"]
      }]
    }
  }
}
```

权威文件为 `.github/execution-manifest.json`；完整字段见 `EXECUTION_CONTRACT.md`。并行分片仅允许 `matrix.shard`，最多八个合法名称，全部成功才签发持续集成证据。

## 4. 合并与持续集成

业务仓库不得自行决定合并结果。

### ❌ 错误做法 / 反面教材

项目内自行发布中央检查状态。

```text
业务仓库测试通过 → 自行设置 validate-merge
```

### ✅ 正确做法 / 规范范例

所有结果由中央核实。

```text
通知桥接或中央对账
    → 安全检查 + 中央持续集成 + 合并请求策略
    → CI Evidence → validate-merge
```

中央通过不可变提交运行测试；必要的本地检查桥接不得持有中央凭据或执行项目测试。

## 5. 安全扫描

扫描配置必须取自可信提交。

### ❌ 错误做法 / 反面教材

接受合并请求自行放宽扫描参数。

```text
合并请求修改安全清单 → 直接作为扫描授权
```

### ✅ 正确做法 / 规范范例

从基础提交读取并校验配置。

```text
可信基础提交 → .github/security-scan.json → 中央扫描
```

私有源仓库无安全隔离扫描能力时严格失败。私有扫描结果不得上传公开控制仓库制品。

## 6. 依赖修复

修复程序只能回写指定的安全路径。

### ❌ 错误做法 / 反面教材

让沙箱直接持有写入凭据。

```text
未知脚本 + 写入令牌 → 直接修改主分支
```

### ✅ 正确做法 / 规范范例

沙箱计算与控制平面写入分离。

```text
可信触发者 → 无写权限沙箱 → 受限产物
            → 中央复核 → 允许路径回写合并请求
```

依赖修复规则来自 `.github/dependency-repair.json`，不按仓库名硬编码。

## 7. 运行器与凭据

项目只声明运行需求。

### ❌ 错误做法 / 反面教材

把主机与中央密钥暴露给项目。

```text
业务仓库 → AW_ADMIN_TOKEN → self-hosted 主机
```

### ✅ 正确做法 / 规范范例

中央按任务授予短期最小权限。

```text
runner_profile → 中央运行器解析
状态读写 → AW_STATUS_API_TOKEN
状态签名 → AW_STATUS_KEYRING
```

接口凭据与签名密钥分离。`AW_EXECUTION_TOKEN` 已被删除。缺少专用权限必须失败，不使用自动令牌回退；具体权限见 `RUNNER_POLICY.md` 和 `07_MAIN_WRITE_GUARD.md`。

## 8. 通知桥接

受管仓库保留唯一薄通知入口。

### ❌ 错误做法 / 反面教材

复制本地中央调度器。

```text
业务仓库 → 自建持续集成和部署控制器
```

### ✅ 正确做法 / 规范范例

桥接文件与中央模板一致。

```text
.github/workflows/notify-action-worker.yml
    → run-pr-governance / cancel-pr-work / run-intake
```

桥接使用受限 `AW_DISPATCH_TOKEN`，不检出或执行源码。桥接不可用时由中央对账补发现；发布及部署仍须主分支来源证明。模板位置为 `templates/bridge/notify-action-worker.yml`。

## 9. 定时与手动任务

任务声明留在项目，调度归中央。

### ❌ 错误做法 / 反面教材

各仓库维护相互独立的定时执行器。

```text
项目甲定时器 + 项目乙定时器 → 重复执行
```

### ✅ 正确做法 / 规范范例

统一从中央校验来源后派发。

```text
.github/task-source.json → 中央对账
          → 变更触发 / 定时触发 / 手动触发
          → 可信主分支证明 → 执行
```

在 GitHub Free 套餐下，组织的私有仓库不支持 rulesets 或保护分支，不能因此放宽中央门禁。发布、部署及故障处理见 `06_RELEASE_DEPLOY_GUIDE.md`。
