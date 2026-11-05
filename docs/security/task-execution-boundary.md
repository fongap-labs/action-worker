# 任务执行边界整改方案

## 当前风险

`.github/workflows/handle-task-dispatch.yml` 的 `execute` Job 在同一 Runner 中先恢复私有任务状态，后执行业务仓库的 `bootstrap.sh`，并在任务结束后继续执行日志封存、状态封存和发布信封处理。

`Execute downstream task` 使用 `env: ${{ secrets }}`。脚本尝试清理中央凭据后再执行业务代码，但同一 Runner 上的后台进程、父进程环境、后续步骤和工作区仍属于同一信任边界。单纯增加 `unset` 或缩小该步骤的环境变量，不能证明后台进程无法读取后续步骤凭据。

## 目标边界

```text
validate (trusted, read-only)
  |
  +--> prepare-state (trusted runner; AW_ARTIFACT_KEY)
  |       restore legacy encrypted state
  |       validate artifact provenance and manifest
  |       re-encrypt state to task-transfer public key
  |       upload ciphertext only
  |
  +--> execute-task (fresh runner; untrusted task boundary)
  |       open state using task-transfer private key
  |       receive only exact task-scoped business credentials
  |       run pinned bootstrap SHA
  |       encrypt resulting state, logs and publication payload
  |       upload ciphertext only
  |
  +--> finalize-state (fresh runner; trusted fixed main SHA)
  |       decrypt task output
  |       validate file tree, identity, size and provenance
  |       seal private state/logs with AW_ARTIFACT_KEY
  |       upload sealed artifacts
  |
  +--> publish (existing admin-ops environment; clean runner)
          decrypt and revalidate publication
          execute fixed central publisher only
```

## 必须新增的信任材料

任务传输必须使用独立 RSA-3072（或更强）密钥对，不能复用发布密钥对：

- `AW_TASK_TRANSFER_PUBLIC_KEY`：非 Secret，可在受控配置中读取。
- `AW_TASK_TRANSFER_PRIVATE_KEY`：仅可信的状态准备/最终处理 Job 可读，存放于现有受保护管理环境；不得注入普通任务 Job。
- 密钥必须先通过公私钥配对校验；未配置时任务执行边界切换必须失败关闭，不得退回同 Runner 模式。

此密钥只用于跨 Job 的一次性 AES-256-GCM 数据密钥封装。AES-GCM AAD 必须绑定用途、仓库、项目、bootstrap SHA、request ID、workflow run ID 和 attempt。不同用途（状态、日志、发布）使用不同 AAD 域。

## 不可信跨边界输入

最终处理 Job 必须把所有任务输出视为不可信数据：

- 只接受固定 Artifact 名称和当前 run ID / attempt。
- 拒绝绝对路径、路径穿越、重复路径、符号链接、硬链接、设备文件及非普通文件。
- 使用 `lstat`、`O_NOFOLLOW` 与文件描述符二次校验，避免检查与读取之间的竞态。
- 限制单文件、总字节数、文件数量、压缩展开比例和 JSON 深度/大小。
- 解密后再次验证仓库、项目、SHA、request ID、run ID、attempt 和用途。
- 不执行任何从任务产物解出的脚本；后处理只能调用固定 SHA 的中央脚本。
- 任何缺失、超时、身份不符、校验失败均停止，不回退到旧的同 Runner 特权处理。

## 攻击验收

必须在独立测试中证明：

1. 后台进程无法读取最终处理 Job 的环境或进程。
2. 修改任务工作区中的中央脚本不影响最终处理逻辑。
3. 任务输出中的符号链接、硬链接、路径穿越和特殊文件全部拒绝。
4. 任务伪造 manifest、publication target、run ID 或 attempt 时全部拒绝。
5. 超大文件、压缩炸弹、畸形 JSON 和重复路径全部拒绝。
6. 任务失败时私有日志仍加密保存，公开日志不泄露私有标识。
7. 历史状态可恢复，新的状态可以继续被下一次运行读取。
8. 任务执行 Job 无法读取 `AW_ARTIFACT_KEY`、`AW_ADMIN_TOKEN`、App 根私钥、发布私钥或状态传输私钥。

## 实施门禁

本方案是 PR 2 的实现合同，不代表边界已经完成。未完成独立密钥初始化、跨 Job 加密传输、攻击测试和历史状态兼容测试前，不得删除旧流程、启用新流程或合并为生产路径。不得在本 PR 中创建 Environment、写入 Secret 或改变生产配置。
