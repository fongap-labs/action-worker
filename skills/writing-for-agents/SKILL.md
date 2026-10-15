---
name: writing-for-agents
description: Writing documents that an agent consumes, such as skills, AGENTS.md, CLAUDE.md, and docs reached by a pointer. Apply only when the document being written is agent-facing; skip it for any other writing.
domain: writing
baseline: true
---

# Writing For Agents

Apply this skill only when the document you write will be read by an agent: a skill, `AGENTS.md`, `CLAUDE.md`, or a doc an agent reaches through a pointer. For any other writing, ignore this skill.

The packaging differs between these documents, but the writing rules do not. The agent follows the same process on every run, so each rule below makes that process predictable.

## 1. Pointers

A **context pointer** names material that is outside the agent's context and states the condition for reaching it. A skill description and a line in `AGENTS.md` are both pointers.

- Front-load the trigger word. The pointer is where it does its triggering work.
- Use one trigger per branch. Synonyms that name the same branch are one trigger written twice; keep one.
- Cut identity that the body already carries.
- Sharpen the wording of a pointer before inlining the material it points to.

## 2. Context load

Every always-loaded line costs on every run, whether or not it applies.

- Put reference material behind a pointer when only some branches need it.
- Split a document by branch or by sequence when one path does not need the other path's content.
- A long document spreads attention thin across its excess lines. Shorten it before adding to it.

## 3. Steps and completion criteria

Every step ends with a completion criterion the agent can check.

- Turn a vague bound such as "understanding reached" into a checkable condition.
- State the demand as well as the output. "Every modified model is accounted for" forces more work than "produce a change list".
- Hide later steps only across a real boundary, such as a subagent dispatch. Hiding them inside the same context does not work.

## 4. Wording

- State the target behavior positively. A prohibition brings the forbidden behavior into context. Use a prohibition only as a hard guardrail that cannot be stated positively, and pair it with the positive target.
- Use one standard term for each recurring concept, and define it once. Reuse an established word instead of restating a triad at every site: "fast, deterministic, low-overhead" can become "tight" once it is defined.

## 5. Single source of truth

- Keep each meaning in one place. A repeated meaning costs maintenance, and it inflates the apparent importance of the meaning.
- Do not restate what the environment already states, such as configuration files, scripts, and the directory layout. Write down what cannot be looked up: the unwritten convention, the reason behind a choice, and the gotcha that no configuration records.

## 6. Pruning

- Delete no-ops. An instruction the agent already follows by default changes nothing.
- Check every line for relevance. Remove a line when the behavior it describes has changed.
- Remove sediment: stale layers kept only because deleting them felt risky.

## 7. Check before finishing

- Each sentence changes behavior compared with the default. If it does not, delete the whole sentence.
- Each pointer names a clear trigger, and each step has a completion criterion.
- No meaning appears in two places.
- The document is written in the language that the repository's rules require for machine-read documents.

## Provenance

Adapted from the `writing-for-agents` skill of `mattpocock/skills` (MIT License, Copyright (c) 2026 Matt Pocock). Its mechanics for skill frontmatter and invocation settings are not included, because Action Worker resolves skills from frontmatter fields of its own.
