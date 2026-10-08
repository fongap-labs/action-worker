# Security Policy

[**English**](SECURITY.md) · [简体中文](SECURITY.zh-CN.md)

## Supported scope

Action Worker is the control plane for the `fongap-labs` organization. Security reports are handled for the current `main` branch only.

## Reporting a vulnerability

Please do not disclose vulnerability details, tokens, secrets, personal data or working exploit steps in public Issues, Pull Requests or Discussions.

Use GitHub's private vulnerability reporting:

```text
Security → Advisories → Report a vulnerability
```

If that entry is unavailable, open one public Issue that contains **no** vulnerability details and only asks for a private channel. A maintainer will move the conversation to a private one.

<!-- TODO(owner): add a backup private contact here (for example a security mailbox). Do not publish a contact that is not monitored. -->

A useful report includes the affected workflow or script, the impact, the smallest conditions needed to reproduce it, and any mitigation you have verified. Please do not include real credentials or unrelated user data.

## Areas of particular interest

- Secrets reaching code that should not see them (task, deploy and sandbox boundaries);
- Bypass of the deterministic gate, CI Evidence, Main Write Guard or Source Policy;
- Forged `repository_dispatch` events that make the control plane run unintended code.
