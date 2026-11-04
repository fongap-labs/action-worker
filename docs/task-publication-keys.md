# 任务产物加密密钥配置

本指南用于 [PR #1380](https://github.com/fongap-labs/action-worker/pull/1380) 的任务执行与发布隔离。**在配好密钥并验证真实私有任务发布之前，不得将 #1380 当作已经完成的生产迁移。**

执行 Job 只能取得 RSA 公钥；受 `admin-ops` Environment 保护的发布 Job 才能取得私钥以及单仓库 GitHub App 写入令牌。

**严禁将 `AW_PUBLICATION_PRIVATE_KEY` 配置为普通 Repository Secret 或 Organization Secret。** 现有下游任务执行步骤使用 `env: ${{ secrets }}`，这两类 Secret 可能进入运行第三方代码的 Job；应只将私钥放在受保护的 `admin-ops` Environment Secret 中。

## 一、本机生成密钥

使用 Node.js 24 或更新版本，在所有 Git 仓库目录之外生成，不得通过网页、聊天、Actions 日志或线上服务生成私钥。

Windows PowerShell：

```powershell
$directory = Join-Path $env:USERPROFILE "AW-Keys\task-publication"
node scripts/prepare-publication-keys.ts generate $directory
node scripts/prepare-publication-keys.ts verify `
  (Join-Path $directory "publication-public.spki.base64") `
  (Join-Path $directory "publication-private.pkcs8.pem")
```

Linux/macOS：

```bash
umask 077
keydir="$HOME/.config/action-worker/task-publication"
node scripts/prepare-publication-keys.ts generate "$keydir"
node scripts/prepare-publication-keys.ts verify \
  "$keydir/publication-public.spki.base64" \
  "$keydir/publication-private.pkcs8.pem"
```

脚本生成 **RSA-3072** 密钥对，以独占创建模式写文件，禁止覆盖已有密钥，拒绝把密钥生成到当前源码仓库中，不会打印密钥内容。POSIX 文件权限设置为 `0600`；Windows 还应检查 NTFS ACL，限制密钥目录仅当前账户可读。

## 二、配置 GitHub

目标仓库：`fongap-labs/action-worker`。

1. 打开 **Settings → Secrets and variables → Actions → Variables**，新增 Repository Variable：`AW_PUBLICATION_PUBLIC_KEY`。内容为 `publication-public.spki.base64` 文件中的完整单行 Base64 字符串。
2. 打开 **Settings → Environments → admin-ops → Environment secrets**，新增 `AW_PUBLICATION_PRIVATE_KEY`。内容为 `publication-private.pkcs8.pem` 的完整 PEM 文本，包含首尾标记行。保留 `admin-ops` 的审批与访问保护。
3. 检查 GitHub App 已在目标仓库获得 `Contents: write`、`Pull requests: write`，在控制仓库获得 `Contents: write`，且安装范围确实包括这些仓库。仅在 App 配置页面勾选权限，并不代表安装端已经批准。

**不要**把私钥文件提交至 Git、发布为 Artifact、粘贴到 PR/Issue、发送到聊天工具或写入运行日志。GitHub Secrets 无法通过普通读取 API 验证其值，可在本机用 `verify` 确认公私钥匹配，再用受保护的实际任务进行端到端验证。

## 三、合并 #1380 前验收

1. 本机执行 `verify`，确认所生成公私钥匹配。
2. 确认 #1380 已基于最新 `main` 通过全部必要 CI 检查。
3. 选择已在仓库策略中授权的小型测试任务，让其生成少量产物。
4. 确认执行 Job 只能使用公钥加密，不存在私钥或 App 写入令牌。
5. 确认受保护发布 Job 可以解密并重新校验产物，目标仓库范围正确，创建的发布 PR 经 `validate-merge` 通过后才合并。
6. 分别测试未经授权的目标仓库、错误私钥与被篡改的密文；三者均必须拒绝发布。
7. 检查公开可见的 Action Worker 日志和 Artifact，确认私有源码、私有仓库标识以及凭据未以明文泄露。

未配置 `AW_PUBLICATION_PUBLIC_KEY` 时，带待发布产物的任务应明确失败；不能为了让任务通过而恢复执行环境中的 `AW_CONTROL_TOKEN`。

## 四、密钥轮换

目前草稿方案只有一组活动密钥，**不支持多密钥同时解密**。仅在没有任务正在发布时成对更新 Repository Variable 与 Environment Secret。旧密钥生成的在途加密产物可能无法再解密，需要重新运行有关任务。

私钥如已泄露，应立即轮换并接受在途发布任务失败，不得继续信任旧密钥。私钥本地备份的保存与销毁应遵循既定密钥托管规则。
