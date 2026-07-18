---
name: skill-creator
description: Create or update an effective Codex-compatible Skill when the user explicitly asks to make a skill, invokes @skill_creator, or needs specialized reusable instructions and contained resources.
---

# Skill Creator

Create a concise, reusable Skill that works through Geulbat's verified plugin Skill runtime.

## Workflow

1. Establish concrete examples of what should trigger the Skill and what successful output looks like. Ask one focused question only when the answer cannot be inferred.
2. Choose a lowercase hyphen-case name of at most 64 characters. Use the same name for the Skill directory and frontmatter `name`.
3. Place the Skill inside a Codex-compatible plugin at `skills/<skill-name>/SKILL.md`. If no plugin exists yet, offer to create a minimal plugin wrapper with `plugin-creator` conventions.
4. Give `SKILL.md` YAML frontmatter exactly two required fields: `name` and a trigger-rich `description`.
5. Keep the body procedural and concise. Put large, conditional detail in directly linked `references/`; deterministic repeated work may use `scripts/`; reusable output material may use `assets/`.
6. Do not add README, changelog, installation guide, empty resource directories, or placeholder files.
7. Never embed credentials, absolute host paths, or authority claims. Skill instructions are guidance and do not bypass normal tool availability or approval.
8. Re-read the finished files and verify frontmatter, containment, referenced resources, and examples before reporting completion.

## Minimal Skill

```markdown
---
name: summarize-notes
description: Summarize meeting notes into decisions, owners, and follow-up actions when the user asks to organize or summarize meeting records.
---

# Summarize Notes

Read the supplied notes, preserve uncertain statements as uncertain, and return decisions, owners, and follow-up actions.
```

After creation, report the plugin-relative Skill path. Do not claim the Skill is active until its containing plugin is installed, enabled, and visible in the Skill catalog.
