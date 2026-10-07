# Security Policy / 安全策略

## English

### Supported scope

Action Worker is the control plane for the `fongap-labs` organization. Security reports are handled for the current `main` branch only.

### Reporting a vulnerability

Please do not disclose vulnerability details, tokens, secrets, personal data or working exploit steps in public Issues, Pull Requests or Discussions.

Use GitHub's private vulnerability reporting:

```text
Security → Advisories → Report a vulnerability
```

If that entry is unavailable, open one public Issue that contains **no** vulnerability details and only asks for a private channel. A maintainer will move the conversation to a private one.

<!-- TODO(owner): add a backup private contact here (for example a security mailbox). Do not publish a contact that is not monitored. -->

A useful report includes the affected workflow or script, the impact, the smallest conditions needed to reproduce it, and any mitigation you have verified. Please do not include real credentials or unrelated user data.

### Areas of particular interest

- Secrets reaching code that should not see them (task, deploy and sandbox boundaries);
- Bypass of the deterministic gate, CI Evidence, Main Write Guard or Source Policy;
- Forged `repository_dispatch` events that make the control plane run unintended code.

## 中文

### 支持范围

Action Worker 是 `fongap-labs` 组织的控制平面。安全问题仅针对当前 `main` 分支处理。

### 报告安全问题

请不要在公开 Issue、Pull Request 或 Discussions 中披露漏洞细节、Token、Secret、个人数据或可直接利用的攻击步骤。

请优先使用 GitHub 的私密漏洞报告入口：

```text
Security → Advisories → Report a vulnerability
```

如果该入口当前不可用，请只创建一个**不包含漏洞细节**的公开 Issue，说明需要私密沟通渠道；维护者确认后再转入私密沟通。

<!-- TODO(owner): 在此补充备用私密联系方式（例如安全邮箱）。不要发布无人监控的联系方式。 -->

有用的报告应包含：受影响的 workflow 或脚本、影响范围、最小复现条件，以及已验证的缓解方式。请勿提交真实凭据或与问题无关的用户数据。

### 重点关注

- Secret 到达本不应接触它的代码（任务、部署、Sandbox 边界）；
- 绕过确定性 Gate、CI Evidence、Main Write Guard 或 Source Policy；
- 伪造 `repository_dispatch` 事件，使控制平面执行非预期代码。
