---
name: plugin-creator
description: Create or update a Codex-compatible plugin package when the user explicitly asks to make a plugin, invokes @plugin_creator, or needs a plugin manifest with Skills, MCP servers, Apps, scripts, or assets.
---

# Plugin Creator

Create a portable Codex-compatible plugin without depending on Codex App, Codex CLI, `CODEX_HOME`, or a client cache.

## Workflow

1. Ask only for missing product intent: the plugin's purpose, desired capabilities, and destination. Prefer the current Computer file scope and a relative destination such as `plugins/my-plugin`.
2. Normalize the plugin name to lowercase hyphen-case with letters, digits, and hyphens. Keep it at most 64 characters. Use the same name for the outer folder and manifest.
3. Create `.codex-plugin/plugin.json` with `name`, `version`, `description`, and `interface.displayName`.
4. Add capability declarations only when their corresponding files actually exist:
   - `skills` for a contained `skills/` tree
   - `mcpServers` for a contained `.mcp.json`
   - `apps` for a contained `.app.json`
5. Keep paths package-relative. Never write a host absolute path, credential value, or user-specific cache path into the package.
6. Create only the resources the requested plugin needs. Avoid empty folders, placeholder manifests, lifecycle install scripts, or auxiliary README files.
7. Re-read the finished manifest and tree. Verify that every declared path exists, remains inside the plugin, and has no symlink escape.
8. Tell the user the relative plugin folder and that it can be installed from **플러그인 관리 → 컴퓨터 폴더에서 설치**. Do not claim installation occurred unless an installation tool actually confirmed it.

## Minimal manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin provides.",
  "interface": {
    "displayName": "My Plugin"
  }
}
```

When the plugin contains Skills, follow the `skill-creator` conventions for each `SKILL.md`.
