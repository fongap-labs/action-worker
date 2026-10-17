---
name: contract-evolution
description: Backward-compatible contract evolution: extend-first, deprecation lifecycle, dual-write transitions, and schema compatibility verification. Use when modifying shared contracts, schemas, or public APIs.
domain: coding
operations: [task, review]
---

# Contract Evolution

Use when modifying a shared contract, JSON Schema, public API, configuration schema, or release behavior.

`change-impact` identifies consumers and classifies impact (`BREAKING`, `REQUIRES_UPDATE`, `COMPATIBLE`, `UNCHANGED`). Run that analysis first. This skill owns the procedure for evolving the contract safely after impact is known.

## 1. Prerequisite: run change-impact

Before evolving a contract:

1. follow `change-impact` to identify all consumers;
2. classify each consumer;
3. record the door (`ONE_WAY` or `TWO_WAY`) and blast radius.

If `change-impact` is not yet run, stop and run it. This skill does not bypass impact analysis.

## 2. Extend-first principle

When adding capability to an existing contract:

- add optional fields, never remove existing ones;
- add new enum values, never narrow existing ones;
- add new endpoints, never change existing signatures;
- widen numeric ranges, never narrow them;
- default new fields to safe values that preserve existing behavior.

A field removal or type change is a `ONE_WAY` door. It requires a deprecation lifecycle (section 3), not a single commit.

## 3. Deprecation lifecycle

When a field, endpoint, or type must be removed:

```text
1. Announce    — mark deprecated in schema and documentation; keep functional
2. Dual-write  — accept both old and new forms; prefer new; warn on old
3. Dual-read   — read from new form; fall back to old with warning
4. Remove old  — only after every consumer is on the new form (confirmed by change-impact)
```

Each stage is a separate PR. Do not collapse stages into one commit.

The time between stage 1 and stage 4 must be long enough for every `REQUIRES_UPDATE` consumer to update. If a consumer cannot update within the window, do not proceed to removal.

## 4. Schema compatibility verification

For every contract change:

- generate a schema diff against the previous version;
- classify each diff: additive (safe), narrowing (breaking), removal (breaking);
- run the contract test suite against both old and new schemas;
- if the project has golden schema snapshots, update them and verify the diff is intentional.

A schema change that passes its own tests but breaks a consumer's parser is not safe.

## 5. Versioning

- contract schema versions use the project's declared `schema_version` field;
- a breaking change increments the major schema version;
- an additive change may keep the same version if the field is optional;
- record the version transition in the contract's changelog or release notes.

## 6. Consumer update verification

For every consumer classified `REQUIRES_UPDATE`:

- update the consumer in the same PR or a coordinated sequence;
- verify the consumer against the new contract;
- if a consumer is outside this repository, record the migration path and timeline;
- do not mark the contract evolution complete while a `REQUIRES_UPDATE` consumer remains unverified.

## 7. Completion

The contract evolution is complete when:

- `change-impact` analysis is recorded;
- every change is additive, or a deprecation lifecycle is in place for removals;
- schema diff is classified and verified;
- contract tests pass against old and new schemas;
- every `REQUIRES_UPDATE` consumer is updated or has a recorded migration plan;
- version transition is documented.
