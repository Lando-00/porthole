---
name: scratch
description: >-
    Create or open a scratch note in the current Copilot session folder and show it in
    VS Code / VS Code Insiders. Use when the user runs /scratch, or asks for a scratch
    pad, notes file, or somewhere to jot working notes for this session.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.2.0
---

# Scratch note in the session folder

Runs `scripts/scratch.ps1` from the plugin root. Notes are written to the current
session folder's `files/` directory, which persists across checkpoints and is
never part of the user's repository.

## Locating the script

The scripts live at the **plugin root**, the grandparent of the directory holding
this `SKILL.md` — `../../scripts/scratch.ps1` relative to this file. Resolve it to
an absolute path first. Do **not** use `${PLUGIN_ROOT}`; it is not expanded in
skill bodies.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\scratch.ps1" -Name "<note-name>" -SessionPath "<current session folder>"
```

Pass the session folder explicitly with `-SessionPath`; you know it from your own
context.

## Choosing arguments

| Situation | Argument |
|---|---|
| Default note | *(none — uses `scratch`)* |
| Named note | `-Name "api-design"` |
| Seed or append content | `-Content "..."` |
| Show rendered, not source | `-Rendered` |

Re-running with the same `-Name` opens the existing note. When `-Content` is also
supplied, it is appended under a timestamped heading rather than overwriting.

## After running

Report the note path and whether it was created, appended to, or just opened.
