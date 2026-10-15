---
name: multi-agent-delegation
description: Rules for delegating work to sub-agents: finite briefs, file ownership, trust boundaries, and coordinator verification. Use only when sub-agents are available and delegation materially improves the task.
domain: coding
operations: [task]
---

# Multi-Agent Delegation

Use only when the environment supports sub-agents and delegation materially improves the task.

Default to no delegation or the smallest useful team.

## 1. Finite brief

Every delegated unit must receive this brief, with every field filled:

```text
Goal:
Scope / owned files:
Do not modify:
Expected result:
Verification:
Stopping bound:
```

## 2. Ownership and ordering

- Two agents must not edit the same file concurrently.
- Shared or foundational files have one owner.
- Do not parallelize work across unresolved producer/consumer, schema/API, migration/runtime, or similar foundational dependencies. Establish the shared contract first.
- Do not send multiple agents to broadly explore the same area.
- Give each agent a focused, non-overlapping question or task.

## 3. Return conditions

A sub-agent returns control to the coordinator when it:

- exceeds its scope;
- reaches its stopping bound;
- repeats the same failed approach (see the anti-loop rule in `agent-execution`);
- reaches an architecture-level decision.

## 4. Trust boundary

Apply the trust boundary in `CLAUDE.md` to every delegated unit:

```text
if the unit reads GitHub metadata, plans, triages, reviews, evaluates CI evidence, or evaluates the gate:
  → control domain; it may use central secrets
if the unit checks out an untrusted change, or builds, tests, or verifies it:
  → sandbox; it must not receive central secrets
```

- A delegated unit never moves sandbox work into the control domain.
- A delegated unit never executes untrusted pull-request code in the control domain.
- Delegation never widens the permissions or secrets of the coordinator.

## 5. Coordinator verification

The coordinator does not repeat every narrow sub-agent check. The coordinator must:

1. verify the combined diff;
2. run the repository's required final integration or project-level gate.

A sub-agent's report is not evidence that the gate passed.

## 6. Honest reporting

Do not invent delegation metrics, fairness statistics, or historical call counts that the environment does not expose.
