---
name: cops
description: >-
    Short alias for /open-session. Opens the current project (git worktree, repository, or
    plain folder) and the current Copilot CLI session folder together in a single VS Code or
    VS Code Insiders workspace. Use when the user runs /cops.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.1.0
---

# `/cops` — alias for `/open-session`

This is a shorthand alias. Follow the `open-session` skill in this same plugin
and perform exactly the same steps.

The script lives at the **plugin root**, the grandparent of the directory holding
this `SKILL.md` — that is, `../../scripts/open-session.ps1` relative to this file.
Resolve it to an absolute path first. Do **not** use `${PLUGIN_ROOT}`; that
placeholder is only expanded in MCP and LSP server configuration.

**Windows (PowerShell):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\open-session.ps1" -SessionPath "<current session folder>"
```

**macOS / Linux:**

```bash
bash "<plugin root>/scripts/open-session.sh" --session "<current session folder>"
```

Pass the current session folder explicitly. Map any user argument
(`insiders`, `code`/`stable`) to `-Editor` / `--editor` as described in the
`open-session` skill, then report the project root, session folder, and the
editor that was launched.
