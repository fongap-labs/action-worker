# 任务发布加密配置

Action Worker 在任务执行器与发布器之间使用非对称加密。任务执行器可能运行下游项目代码，**绝不能获得用于解密的 RSA 私钥**。发布操作必须在受 `admin-ops` 保护的独立 Job 中执行。

## 一、离线生成密钥

在可信任的管理员计算机上生成一对 RSA 3072 位密钥。私钥不得提交到仓库，也不要粘贴到 PR、Issue、聊天或工作流日志。

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out publication-private.pem
openssl pkey -in publication-private.pem -pubout -outform DER -out publication-public.der
node -e "const fs=require('node:fs');console.log(fs.readFileSync('publication-public.der').toString('base64'))"
```

以上命令会生成 PEM 格式私钥，以及 DER 格式公钥；最后一条命令输出公钥的 Base64 字符串。

## 二、配置密钥

**私钥**：打开 `action-worker → Settings → Environments → admin-ops → Environment secrets`，创建 `AW_PUBLICATION_PRIVATE_KEY`。填写完整 PEM 文本，保留 `BEGIN PRIVATE KEY` 和 `END PRIVATE KEY` 标记。

**公钥**：打开 `action-worker → Settings → Secrets and variables → Actions → Variables`，创建仓库变量 `AW_PUBLICATION_PUBLIC_KEY`，填写刚才输出的 Base64 公钥字符串。

**禁止把 `AW_PUBLICATION_PRIVATE_KEY` 存为 Repository Secret 或 Organization Secret。** 旧任务执行步骤为了注入项目所需的凭据，仍使用 `env: ${{ secrets }}`。如果私钥被配置成仓库级或组织级 Secret，就可能进入未受保护的任务执行环境。因此工作流新增检查：一旦执行任务时检测到此私钥，就明确失败，不进行 Token 回退。

确保 `admin-ops` 设置了合理的分支限制和必要审核人员。临时私钥文件应按照组织密钥保管规范保护并在配置结束后安全清理。

## 三、最小权限

- 发布目标仓库需要 `Contents: write`、`Pull requests: write`。
- `action-worker` 控制仓库需要 `Contents: write`，用于发送 `run-intake`。
- 不使用宽权限个人 PAT 代替 GitHub App，也不绕过分支保护。

## 四、合并前必须实测

准备一项受控任务，让它确实产出发布清单 `manifest.json` 和有效文件，然后检查：

1. `execute` Job 不接触发布私钥，仅上传加密文件。
2. 新的 `publish` Job 在 `admin-ops` 环境解密，重新校验清单和文件，并创建目标仓库 PR。
3. 发布 PR 继续执行 `validate-merge`，未跳过审核或强制合并。
4. 工作流日志、Artifact 元数据、PR 标题与正文不泄露私有来源身份。
5. 缺失密钥、密钥对不匹配、GitHub App 权限不足时必须明确失败。

加密 Artifact 只保留一天。**发布任务仍在运行时不得更换密钥对**，否则公钥加密的数据可能无法由新私钥解密。按批准的密钥轮换程序操作。

配置完成不代表已经验证成功；只有上述端到端场景通过后，才能将 #1380 从 Draft 改为 Ready。
