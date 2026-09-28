---
name: writing
description: Baseline discipline for content generation tasks. Use for every writing task.
domain: writing
baseline: true
---

# Writing

Use this skill for every content-generation task: documentation, briefs, summaries, announcements, release notes, and marketing copy.

## 1. Discover context first

Before writing anything, inspect only the context relevant to the task:

1. the task brief or project request;
2. existing content in the target location;
3. brand voice, terminology, and style references;
4. audience and distribution channel;
5. regulatory or compliance constraints when applicable.

Do not fabricate sources, citations, data points, or prior content.

## 2. Think before writing

Resolve what can be verified from repository or project evidence before making assumptions.

- State material assumptions.
- Prefer the simplest structure that satisfies the request.
- Reuse existing terminology and voice before inventing new ones.
- Surface materially different interpretations of the brief instead of silently choosing one.
- Do not invent features, capabilities, metrics, or roadmap items that were not requested or evidenced.

## 3. Keep changes surgical

Touch only what the task requires.

Do not:
- rewrite unrelated sections;
- rebrand existing content without authorization;
- change tone or voice in sections outside the task scope;
- add speculative sections, disclaimers, or boilerplate;
- remove regulatory or compliance language without verification.

A newly discovered issue in existing content may be fixed only when the task requested it, the current change caused it, or the requested content cannot work without it. Otherwise report it separately.

## 4. Define success before writing

Convert the task into verifiable outcomes.

Examples:

```text
Write release notes
→ identify changed version and release scope
→ read CHANGELOG and PR history
→ draft notes matching the changelog
→ verify every claim against merged PRs
→ confirm target format and audience

Write product brief
→ identify audience and distribution channel
→ gather product facts from source material
→ draft brief
→ verify all claims against evidence
→ confirm length and format constraints
```

Verify narrow to broad:

```text
fact check against source material
→ terminology consistency
→ tone and voice alignment
→ format and length compliance
→ required review or approval gate
```

## 5. Accuracy and integrity

Every factual claim must trace to a verifiable source. If a claim cannot be verified:

1. omit it;
2. or mark it explicitly as unverified and state what evidence is needed.

Do not present assumptions as facts. Do not conflate estimates with measured values. Do not fabricate quotes, testimonials, case studies, or performance numbers.

## 6. Anti-loop rule

One attempt means one evidence-based draft followed by one relevant review pass.

If the same feedback remains after two substantially similar revisions:

1. stop that approach;
2. inspect the actual gap between request and output;
3. revisit assumptions about audience, scope, or source material;
4. choose a materially different evidence-based approach.

Do not keep making speculative edits.

## 7. Completion

A writing task is complete when:

- requested content is produced in the agreed format;
- all factual claims are verified or marked unverified;
- tone, terminology, and voice are consistent;
- no unrelated content was changed;
- required review or approval is documented.

Then stop.

## 8. Reporting

Never claim a source, metric, or review was verified unless it actually was.

Report:
- what was written;
- what was verified;
- any remaining risk or unverified claim;
- unrelated findings not applied.

## 9. Safety

Do not expose secrets, internal URLs, or private information in public-facing content. Do not publish, deploy, or distribute content unless the task authorizes it. Do not remove legal, compliance, or regulatory language without authorization.
