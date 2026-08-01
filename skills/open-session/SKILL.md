---
name: open-session
description: >-
    Open the current project (git worktree, repository, or plain folder) and the current
    Copilot CLI session folder together in a single VS Code or VS Code Insiders workspace.
    Use when the user runs /open-session or /cops, or asks to open this project and the
    session folder in VS Code, open the session workspace, or see the session files in an editor.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.1.0
---

# Open project + Copilot session in one workspace

Launch a single editor window containing two folder roots:

1. The current project — the git worktree root when inside a repository, otherwise the current directory.
2. The current Copilot CLI session folder.

## How to run it

Run the bundled script. It generates a `.code-workspace` file in the system temp
directory and opens it.

### Locating the script

The script lives at the **plugin root**, which is the grandparent of the
directory holding this `SKILL.md`:

```text
<plugin root>/
├── skills/open-session/SKILL.md   <- this file
└── scripts/open-session.ps1       <- the script
```

So from this file the script is `../../scripts/open-session.ps1`. Resolve that
to an absolute path before running it.

Do **not** use `${PLUGIN_ROOT}` here — that placeholder is only expanded in MCP
and LSP server configuration, not in skill instructions.

**Windows (PowerShell):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\open-session.ps1" -SessionPath "<current session folder>"
```

**macOS / Linux:**

```bash
bash "<plugin root>/scripts/open-session.sh" --session "<current session folder>"
```

### Passing the session folder

Always pass `-SessionPath` / `--session` explicitly using the session folder path
from your own context — you know the current session's directory, and passing it
guarantees the correct session is opened.

If you genuinely cannot determine it, omit the argument: the script falls back to
the most recently modified directory under `~/.copilot/session-state` (or
`$COPILOT_HOME/session-state`). Mention that a fallback was used.

### Arguments the user may supply

The user can pass an argument to `/open-session` or `/cops`:

| User argument | Add to the command |
|---|---|
| `insiders` | `-Editor insiders` / `--editor insiders` |
| `code` or `stable` | `-Editor code` / `--editor code` |
| *(none)* | omit — defaults to `auto`, preferring Insiders |

To pin the project explicitly, add `-ProjectPath <path>` / `--project <path>`.
To build the workspace without launching an editor, add `-DryRun` / `--dry-run`.

## After running

Report the project root, the session folder, and which editor was launched.

If Copilot CLI is already connected to an IDE, the script **reuses that window**
and adds the session folder to it with `--add`, instead of opening a second
window on a generated workspace. It will say so; report that too. Pass
`-ForceWorkspace` if the user explicitly wants a separate workspace window.

If the script reports that no editor was found, tell the user to install VS Code
or add its `bin` directory to `PATH` — do not try to launch an editor another way.

## Notes

- The workspace file is written to the system temp directory, never into the
  user's repository, so it can never be committed by accident.
- Its name is deterministic per project + session, so re-running reuses the same
  workspace file instead of creating duplicates.
- Linked git worktrees resolve to the worktree root, not the main repository.
