# 状态签名升级的历史证据迁移

状态：本次故障修复的固定迁移记录。

2026-11-03 21:29:15 UTC 的签名升级使旧状态无法验证。本记录列出迁移的全部 21 个成功状态；没有按日期、仓库或操作者整体放行。已核对下列 14 个原始控制运行均在 main 上成功完成，发布作业也成功；作业日志中的目标仓库、提交与成功结果和下方原始状态逐项对应。

每条摘要按 UTF-8 编码的 JSON 数组计算 SHA-256：`["action-worker-status-migration-v1", repository.toLowerCase(), sha.toLowerCase(), context, state, description, target_url, id, created_at]`。摘要存于 `policies/status-migration.json`，匹配后仍需通过原始运行与合并来源检查。此清单不允许新创建的无签名状态复用；状态 ID 与创建时间也是摘要的一部分。

## 核实的发布作业

| 原始运行 | 发布作业 | 作业日志 |
|---|---|---|
| [41648081773](https://github.com/fongap-labs/action-worker/actions/runs/41648081773) | Publish Central CI | [125959436188](https://github.com/fongap-labs/action-worker/actions/runs/41648081773/job/125959436188) |
| [41648017125](https://github.com/fongap-labs/action-worker/actions/runs/41648017125) | PR Governance | [125958402766](https://github.com/fongap-labs/action-worker/actions/runs/41648017125/job/125958402766) |
| [41624981015](https://github.com/fongap-labs/action-worker/actions/runs/41624981015) | Publish Central CI | [125885127986](https://github.com/fongap-labs/action-worker/actions/runs/41624981015/job/125885127986) |
| [41624891050](https://github.com/fongap-labs/action-worker/actions/runs/41624891050) | PR Governance | [125879745065](https://github.com/fongap-labs/action-worker/actions/runs/41624891050/job/125879745065) |
| [41660681485](https://github.com/fongap-labs/action-worker/actions/runs/41660681485) | Publish Central CI | [126006236663](https://github.com/fongap-labs/action-worker/actions/runs/41660681485/job/126006236663) |
| [41660618743](https://github.com/fongap-labs/action-worker/actions/runs/41660618743) | PR Governance | [126002510660](https://github.com/fongap-labs/action-worker/actions/runs/41660618743/job/126002510660) |
| [40693460448](https://github.com/fongap-labs/action-worker/actions/runs/40693460448) | Publish Central CI | [122834914169](https://github.com/fongap-labs/action-worker/actions/runs/40693460448/job/122834914169) |
| [40693415422](https://github.com/fongap-labs/action-worker/actions/runs/40693415422) | PR Governance | [122833773172](https://github.com/fongap-labs/action-worker/actions/runs/40693415422/job/122833773172) |
| [41627010822](https://github.com/fongap-labs/action-worker/actions/runs/41627010822) | Publish Central CI | [125887045635](https://github.com/fongap-labs/action-worker/actions/runs/41627010822/job/125887045635) |
| [41626971733](https://github.com/fongap-labs/action-worker/actions/runs/41626971733) | PR Governance | [125886637792](https://github.com/fongap-labs/action-worker/actions/runs/41626971733/job/125886637792) |
| [41647957814](https://github.com/fongap-labs/action-worker/actions/runs/41647957814) | Publish Central CI | [125958893674](https://github.com/fongap-labs/action-worker/actions/runs/41647957814/job/125958893674) |
| [41647920738](https://github.com/fongap-labs/action-worker/actions/runs/41647920738) | PR Governance | [125958924666](https://github.com/fongap-labs/action-worker/actions/runs/41647920738/job/125958924666) |
| [41473168146](https://github.com/fongap-labs/action-worker/actions/runs/41473168146) | Publish Central CI | [125372948566](https://github.com/fongap-labs/action-worker/actions/runs/41473168146/job/125372948566) |
| [41473167251](https://github.com/fongap-labs/action-worker/actions/runs/41473167251) | PR Governance | [125373202006](https://github.com/fongap-labs/action-worker/actions/runs/41473167251/job/125373202006) |

## 精确的原始状态

以下值来自 GitHub API；它们不包含凭据。

```json
[
  {
    "repository": "fongap-labs/ai-gateway",
    "sha": "75f3a5c59ca0800395b07f55a913224fde87f3f1",
    "status": {
      "id": 57943427819,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41648081773",
      "created_at": "2026-11-03T13:52:55Z"
    }
  },
  {
    "repository": "fongap-labs/ai-gateway",
    "sha": "75f3a5c59ca0800395b07f55a913224fde87f3f1",
    "status": {
      "id": 57943435163,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41648017125",
      "created_at": "2026-11-03T13:53:00Z"
    }
  },
  {
    "repository": "fongap-labs/ai-gateway",
    "sha": "75f3a5c59ca0800395b07f55a913224fde87f3f1",
    "status": {
      "id": 57943437060,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41648017125",
      "created_at": "2026-11-03T13:53:01Z"
    }
  },
  {
    "repository": "fongap-labs/app-source",
    "sha": "20fd77ca3b99b137b438a6bd12177d5d4bcde3c2",
    "status": {
      "id": 57931842406,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41624981015",
      "created_at": "2026-11-03T11:19:08Z"
    }
  },
  {
    "repository": "fongap-labs/app-source",
    "sha": "20fd77ca3b99b137b438a6bd12177d5d4bcde3c2",
    "status": {
      "id": 57931868241,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41624891050",
      "created_at": "2026-11-03T11:19:29Z"
    }
  },
  {
    "repository": "fongap-labs/app-source",
    "sha": "20fd77ca3b99b137b438a6bd12177d5d4bcde3c2",
    "status": {
      "id": 57931869795,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41624891050",
      "created_at": "2026-11-03T11:19:31Z"
    }
  },
  {
    "repository": "fongap-labs/delta",
    "sha": "aa4f956a9ab83edb70924f843aed882075f59de7",
    "status": {
      "id": 57951162424,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41660681485",
      "created_at": "2026-11-03T15:13:52Z"
    }
  },
  {
    "repository": "fongap-labs/delta",
    "sha": "aa4f956a9ab83edb70924f843aed882075f59de7",
    "status": {
      "id": 57951192907,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41660618743",
      "created_at": "2026-11-03T15:14:10Z"
    }
  },
  {
    "repository": "fongap-labs/delta",
    "sha": "aa4f956a9ab83edb70924f843aed882075f59de7",
    "status": {
      "id": 57951195614,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41660618743",
      "created_at": "2026-11-03T15:14:12Z"
    }
  },
  {
    "repository": "fongap-labs/delta-suite",
    "sha": "985f47e8cf6fdaca7242120ac2d4185170b73b8c",
    "status": {
      "id": 57469397061,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/40693460448",
      "created_at": "2026-10-28T13:08:39Z"
    }
  },
  {
    "repository": "fongap-labs/delta-suite",
    "sha": "985f47e8cf6fdaca7242120ac2d4185170b73b8c",
    "status": {
      "id": 57469435974,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/40693415422",
      "created_at": "2026-10-28T13:09:07Z"
    }
  },
  {
    "repository": "fongap-labs/delta-suite",
    "sha": "985f47e8cf6fdaca7242120ac2d4185170b73b8c",
    "status": {
      "id": 57469437553,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/40693415422",
      "created_at": "2026-10-28T13:09:08Z"
    }
  },
  {
    "repository": "fongap-labs/dsh-plugin",
    "sha": "57b5482d924b1f4e9b20c5676b1ef38e07bc1168",
    "status": {
      "id": 57932135867,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41627010822",
      "created_at": "2026-11-03T11:23:17Z"
    }
  },
  {
    "repository": "fongap-labs/dsh-plugin",
    "sha": "57b5482d924b1f4e9b20c5676b1ef38e07bc1168",
    "status": {
      "id": 57932215509,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41626971733",
      "created_at": "2026-11-03T11:24:24Z"
    }
  },
  {
    "repository": "fongap-labs/dsh-plugin",
    "sha": "57b5482d924b1f4e9b20c5676b1ef38e07bc1168",
    "status": {
      "id": 57932216840,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41626971733",
      "created_at": "2026-11-03T11:24:25Z"
    }
  },
  {
    "repository": "fongap-labs/external-vault",
    "sha": "2a40fa84584ac9d78eda2b88b48b3ae4a3aa47d7",
    "status": {
      "id": 57943340233,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41647957814",
      "created_at": "2026-11-03T13:51:54Z"
    }
  },
  {
    "repository": "fongap-labs/external-vault",
    "sha": "2a40fa84584ac9d78eda2b88b48b3ae4a3aa47d7",
    "status": {
      "id": 57943372155,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41647920738",
      "created_at": "2026-11-03T13:52:16Z"
    }
  },
  {
    "repository": "fongap-labs/external-vault",
    "sha": "2a40fa84584ac9d78eda2b88b48b3ae4a3aa47d7",
    "status": {
      "id": 57943373937,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41647920738",
      "created_at": "2026-11-03T13:52:17Z"
    }
  },
  {
    "repository": "fongap-labs/internal-vault",
    "sha": "398e22871046bd914ddbb0771f3ba2d8dcca4035",
    "status": {
      "id": 57851633462,
      "context": "CI Evidence",
      "state": "success",
      "description": "Central CI passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41473168146",
      "created_at": "2026-11-02T15:38:09Z"
    }
  },
  {
    "repository": "fongap-labs/internal-vault",
    "sha": "398e22871046bd914ddbb0771f3ba2d8dcca4035",
    "status": {
      "id": 57851704530,
      "context": "PR Governance",
      "state": "success",
      "description": "Action Worker PR governance passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41473167251",
      "created_at": "2026-11-02T15:38:54Z"
    }
  },
  {
    "repository": "fongap-labs/internal-vault",
    "sha": "398e22871046bd914ddbb0771f3ba2d8dcca4035",
    "status": {
      "id": 57851706496,
      "context": "validate-merge",
      "state": "success",
      "description": "Action Worker merge gate passed",
      "target_url": "https://github.com/fongap-labs/action-worker/actions/runs/41473167251",
      "created_at": "2026-11-02T15:38:55Z"
    }
  }
]
```

