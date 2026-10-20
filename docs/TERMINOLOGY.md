# 术语表（英文键 + 中文解释）

机器文档引用英文键；人类文档引用中文解释。禁止在同一文档中混用两套术语。

## 配置类型词（外部配置保留的标准词）

| 英文键 | 中文解释 |
|--------|----------|
| TOKEN | 令牌，用于认证的不透明字符串 |
| KEY | 密钥，加密/签名用的私有材料 |
| SECRET | 机密，泛指不应泄露的配置值 |
| ID | 标识符，唯一标识某资源 |
| URL | 统一资源定位符 |
| URI | 统一资源标识符 |
| PATH | 路径，文件系统或对象存储路径 |
| FILE | 文件名或文件路径 |
| DIR | 目录路径 |
| JSON | JSON 格式数据 |
| YAML | YAML 格式数据 |
| NAME | 名称，人类可读的标识 |
| REF | 引用，如 Git ref、容器镜像引用 |
| SHA | Git 提交 SHA-1 哈希（40 位小写十六进制） |
| VERSION | 版本号（SemVer 或其他规范） |
| TIMEOUT | 超时时长（通常带单位后缀，如 `30s`） |
| DELAY | 延迟时长 |
| INTERVAL | 间隔时长 |
| LIMIT | 限额、上限 |
| COUNT | 计数 |
| SIZE | 大小（字节、条目数等） |
| BYTES | 字节数 |
| PORT | 端口号 |
| HOST | 主机名或 IP |
| REGION | 区域标识 |
| REPOSITORY | 仓库标识（`owner/name`） |
| MODE | 运行模式 |
| CONFIG | 配置对象或文件 |

> 新的凭据不得使用 `PAT` 作为标准类型词；应使用更通用的 `TOKEN` 或 `KEY`，除非第三方平台原生字段名必须保持不变。

---

## 规范术语（核心概念）

| 英文键 | 中文解释 |
|--------|----------|
| contract | 机器合同（输入输出 Schema、版本化、可验证） |
| change type | 主变更类别（feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert） |
| change area | 技术变更区域（scope，可选） |
| triage | 快速语义路由（将发现分类为阻断/警告/信息） |
| review | 代码审查 |
| finding | 审查结果（单条发现） |
| policy | 确定性规则（机器可执行，无歧义） |
| override | 策略例外（显式、可审计、有时效） |
| context | 项目证据（PR diff、清单、能力请求等） |
| provider | 模型供应商（Anthropic/OpenAI/Google/...） |
| gateway | 路由端点（统一入口，协议转换、熔断、限流） |
| task | 工作单元（可调度、可重试、有产物） |
| dispatch | 分发（发送执行请求到中央平面） |
| status | 状态（GitHub commit status / check run） |
| validate / validation | 校验（确定性通过/失败） |
| release | 发布（构建、打包、Provenance、治理、分发） |
| tag | Git 标签（`release-key-v<version>`） |
| CI | 持续集成 |
| execution request | 执行请求（schema_version, request_id, repository, source_sha, operation） |
| execution manifest | 项目执行声明（operation, runner_profile, command, matrix, artifacts, timeout_minutes, capability_requests） |
| executor | 通用执行单元（Runner + 环境 + 凭据范围） |
| capability request | 请求的权限（如 `source.read`、`deploy:production`） |
| capability grant | 授予的权限（由中央策略决定） |
| runner profile | 抽象的计算需求（如 `linux-standard`、`production-deploy`） |
| runner resolver | Runner 选择组件（按 profile 解析到 backend） |
| runner backend | 计算提供方类别（GitHub-hosted / self-hosted / 云实例） |

---

## 推荐动词（英文文档、代码注释、日志、错误信息）

```
get  load  fetch  create  update  delete  validate  detect  resolve  evaluate
build  generate  handle  execute  publish  summarize
```

- 布尔值命名：`isXxx` / `hasXxx` / `canXxx` / `shouldXxx`
- 禁止在长期控制平面名称中使用：`new` / `final` / `latest` / `temp` / `tmp` / `impl` / `helper` / `common` / `misc` / `shared`（明确定义的领域概念除外）

---

## 系统缩写（已登记，可用于外部配置）

| 系统 | 缩写 |
|------|------|
| Action Worker | `AW` |
| AI Gateway | `AIG` |
| App Source | `APP_SOURCE` |
| Delta | `DELTA` |
| Server Edge | `SERVER_EDGE` |

新增系统缩写：先修改此表，再在业务仓库使用。