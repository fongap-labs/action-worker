# 命名规范

## 1. 标准段数

新增自有名称强制三个语义段。

### ❌ 错误做法 / 反面教材

缺少用途或类型。

```text
AW_TOKEN
MCP_KEY
validate.ts
```

### ✅ 正确做法 / 规范范例

配置标识归属、用途、类型。

```text
SYSTEM_PURPOSE_TYPE
AW_STATUS_TOKEN
MCP_ADMIN_KEY
validate-naming-rules.ts
```

## 2. 第四段

三段不够时才增加第四段。

### ❌ 错误做法 / 反面教材

堆叠重复词或第五段。

```text
AW_AI_AGENT_WRITING_MODEL_CONFIG
```

### ✅ 正确做法 / 规范范例

第四段必须消除真实歧义。

```text
SYSTEM_MODULE_PURPOSE_TYPE
AW_STATUS_SIGNING_KEY
AW_AI_AGENT_CONFIG
```

复杂参数优先采用结构化配置，不新增长于四段的自有外部变量。

## 3. 平台标准名称

标准平台名称遵循平台原样。

### ❌ 错误做法 / 反面教材

为了凑段数改写标准名称。

```text
GITHUB_ACTIONS_ACCESS_TOKEN
NODE_RUNTIME_OPTIONS
```

### ✅ 正确做法 / 规范范例

保留平台原生名称。

```text
GITHUB_TOKEN
NODE_OPTIONS
package.json
Cargo.toml
Dockerfile
```

**标准平台名称不受强制段数限制，不允许例外登记。** 不建立例外清单、审批或白名单。

## 4. 文件名称

自有普通文件用三个短横线语义段。

### ❌ 错误做法 / 反面教材

名称含糊或重复目录。

```text
helper.ts
scripts/scripts-task-helper.ts
```

### ✅ 正确做法 / 规范范例

动作、对象和职责准确对应。

```text
validate-naming-rules.ts
dispatch-central-ci.ts
session-state-manager.ts
```

仅职责无法表达时允许第四段；扩展名不计段数。治理文档沿用大写下划线及既有编号，不随意修改引用。

## 5. 源码标识符

局部标识符遵循语言原生习惯。

### ❌ 错误做法 / 反面教材

无意义地重复系统前缀。

```typescript
const actionWorkerSessionStateRestoreResult = true;
```

### ✅ 正确做法 / 规范范例

作用域内只保留必要含义。

```typescript
const isEnabled = policy.isEnabled;
const model = request.model;
function restoreSessionState() {}
```

局部变量、函数及参数不强制三段。布尔名称优先使用 `is`、`has`、`can`、`should`。

## 6. 缩写与归属

系统缩写只在术语表统一定义。

### ❌ 错误做法 / 反面教材

临时发明缩写并省略归属。

```text
STATUS_KEY
ARTIFACT_REPOSITORY
```

### ✅ 正确做法 / 规范范例

使用已定义系统前缀。

```text
AW_STATUS_KEY
APP_SOURCE_AUTH_TOKEN
SERVER_EDGE_ACCESS_KEY
```

`APP_SOURCE`、`SERVER_EDGE` 各算一个复合系统语义段；术语维护不属于例外登记。格式后缀 `JSON` 等仅在协议要求时使用。

## 7. 中央仓库边界

中央仓库只容纳通用实现。

### ❌ 错误做法 / 反面教材

按某个业务仓库创建专属控制目录。

```text
projects/specific-repository/
profiles/specific-repository/
```

### ✅ 正确做法 / 规范范例

按合同及执行职责分层。

```text
docs/
contracts/
policies/
rules/
scripts/
tests/
```

业务仓库可使用产品目录；中央配置不得直接暴露具体执行主机，统一使用 `runner_profile`。

## 8. 工作流命名

新增工作流优先三段，最多三段。

### ❌ 错误做法 / 反面教材

包含仓库名、产品名或冗余前缀。

```text
handle-source-script-deploy.yml
my-product-release-app.yml
```

### ✅ 正确做法 / 规范范例

按事件和职责命名。

```text
handle-task-dispatch.yml
security-scan-dispatch.yml
release-app.yml
deploy-source-script.yml
```

`intake.yml` 是既有单一对账入口；工作流分类、触发与权限以 `tests/workflow-classes.test.ts` 为准。现有入口不得未经引用及证据链验证直接改名。

## 9. 迁移与校验

现行合同必须先验证再迁移。

### ❌ 错误做法 / 反面教材

直接重命名密钥导致工作流失效。

```text
删除旧密钥 → 修改引用 → 不执行测试
```

### ✅ 正确做法 / 规范范例

先清查引用、再验证迁移。

```text
引用清查 → 同步配置和代码 → 合同测试 → 切换名称
```

门禁从 `policies/naming.json` 读取可机械执行的规则：受控脚本、测试、工作流和 Shell 文件名使用小写 kebab-case；新增受控源码文件至少三个语义段，文件名最多三个段；拒绝生命周期词和泛化文件名。源码校验器检查 Python、Rust、TypeScript 布尔命名；外部配置校验系统归属前缀、禁用 PAT 术语并强制布尔前缀。语义是否准确、三段是否表达清晰仍需评审，机器不判断词义。
