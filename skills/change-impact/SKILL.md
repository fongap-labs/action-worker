---
name: change-impact
description: Determine the blast radius of shared code, interfaces, workflows, policies, releases, and cross-repository changes.
domain: coding
operations: [review, build, deploy]
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

## 6. Door and blast radius

Record two fields in the report:

```text
Door: ONE_WAY | TWO_WAY
Blast radius: one short phrase naming the widest affected scope
```

- `ONE_WAY`: a later commit or rollback cannot restore the previous state. Examples: deleted data, published artifacts, destructive migrations, removed public interfaces.
- `TWO_WAY`: a later commit or rollback restores the previous behavior.

A `ONE_WAY` change must name its point of no return and the evidence that has to pass before it ships.

## 7. Completion

The change is not complete until every `REQUIRES_UPDATE` consumer is updated or explicitly excluded with evidence, and the door and blast radius are recorded.

## Provenance

The door (one-way or two-way) and blast-radius fields are adapted from the `pr` skill of `mattpocock/skills` (MIT License, Copyright (c) 2026 Matt Pocock). Its pull-request body template is not included, because each managed repository's own template governs the PR body.
