---
name: change-impact
description: Determine the blast radius of shared code, interfaces, workflows, policies, releases, and cross-repository changes.
---

# Change Impact

Use before modifying shared contracts, reusable workflows, central governance, public APIs, configuration schemas, or release behavior.

## 1. Identify the changed contract

Describe exactly what changes:

```text
producer
interface / workflow / schema / behavior
consumers
compatibility expectation
```

Do not use vague labels such as "shared code" when a concrete contract can be named.

## 2. Find consumers

Check:
- direct imports/calls;
- workflow callers;
- config readers;
- generated artifacts;
- release consumers;
- documentation examples;
- tests;
- managed repositories.

For Action Worker changes, explicitly consider all repositories that consume the changed central behavior.

## 3. Classify impact

For every consumer:

```text
UNCHANGED
COMPATIBLE
REQUIRES_UPDATE
BREAKING
UNKNOWN
```

Resolve UNKNOWN where feasible before editing.

## 4. Prefer one authority

If the behavior is shared by multiple repositories, keep one source of truth and thin consumers.

Do not solve cross-repository drift by copying the same logic into every repository.

## 5. Verification plan

Map each impacted contract to evidence:

```text
contract change
→ owner test
→ consumer test
→ cross-repository/integration verification
```

Only run broad checks justified by the blast radius.

## 6. Completion

The change is not complete until every `REQUIRES_UPDATE` consumer is updated or explicitly excluded with evidence.
