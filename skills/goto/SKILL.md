---
name: goto
description: >-
    Open a file at a specific line and column in VS Code / VS Code Insiders. Use when the
    user runs /goto, or asks to jump to, show, open or highlight a particular file,
    function, error or line in the editor.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.2.0
---

# Jump to a file and line in VS Code

Runs `scripts/goto.ps1` from the plugin root. It reuses the connected IDE window
when Copilot CLI is attached to one, so it never spawns a second editor.

## Locating the script

The scripts live at the **plugin root**, the grandparent of the directory holding
this `SKILL.md` — `../../scripts/goto.ps1` relative to this file. Resolve it to an
absolute path first. Do **not** use `${PLUGIN_ROOT}`; it is not expanded in skill
bodies.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\goto.ps1" -Target "<file>:<line>:<col>"
```

## Choosing arguments

| Situation | Argument |
|---|---|
| File and line known | `-Target "src/app.ts:42"` |
| Line and column known | `-Target "src/app.ts:42:9"` |
| Whole file | `-Target "src/app.ts"` |
| Force a separate window | add `-NewWindow` |
| VS Code stable instead | add `-Editor code` |

Relative paths resolve against the git/project root first, then the current
directory, so paths as reported by build output or tests usually work unchanged.

## Notes

`--goto` places the cursor at that position and reveals it. It cannot select a
range — VS Code's CLI has no flag for that. If the user wants a whole region
highlighted, jump to its first line and say that the cursor is at the start of
the range.

## After running

Report the resolved absolute path and the position opened. If the file was not
found, say so plainly rather than guessing at a different file.
