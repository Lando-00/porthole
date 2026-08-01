---
name: vsdiff
description: >-
    Open diffs in VS Code / VS Code Insiders. Use when the user runs /vsdiff, or asks to
    see changes, uncommitted changes, a commit's diff, a diff between branches or commits,
    or to compare two files side by side in the editor. Named vsdiff because /diff is a
    built-in Copilot CLI command.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.2.0
---

# Open diffs in VS Code

Runs `scripts/vsdiff.ps1` from the plugin root. That script materialises both
sides of each diff to disk and launches the editor **detached**, so it returns
immediately.

Do not use `git difftool` for this — it blocks until the editor window is closed,
because git deletes its temporary files as soon as the command returns.

## Locating the script

The scripts live at the **plugin root**, the grandparent of the directory holding
this `SKILL.md` — `../../scripts/vsdiff.ps1` relative to this file. Resolve it to
an absolute path first. Do **not** use `${PLUGIN_ROOT}`; that placeholder is only
expanded in MCP and LSP configuration, never in skill bodies.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\vsdiff.ps1" [args]
```

## Choosing arguments

| The user asks for | Arguments |
|---|---|
| "my changes", "uncommitted", "what changed" | *(none)* |
| staged changes | `-Ref staged` |
| a specific commit | `-Ref <sha>` |
| between two refs | `-Ref "main..HEAD"` |
| two specific files | `-Files "<a>","<b>"` |
| only some paths | add `-Path "src/"` |
| more than 10 files | add `-MaxFiles 25` |
| VS Code stable instead | add `-Editor code` |

Default with no arguments is uncommitted working-tree changes versus `HEAD`.

## After running

Report how many diffs opened and which files. If the script warns that output was
capped, say so and offer `-MaxFiles` or `-Path` to narrow.

If it reports "No changes found", state that plainly — do not open anything else.

Added and deleted files are diffed against an empty placeholder so they still
render; mention this if it is relevant to what the user sees.
