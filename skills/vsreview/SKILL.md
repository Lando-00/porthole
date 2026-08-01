---
name: vsreview
description: >-
    Open every file changed on a branch or PR as diffs in VS Code / VS Code Insiders. Use
    when the user runs /vsreview, or asks to review a branch, review a PR, or see all the
    changes on this branch in the editor. Named vsreview because /review is a built-in
    Copilot CLI command that runs the code review agent.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.2.0
---

# Review a branch's changes in VS Code

Runs `scripts/vsreview.ps1` from the plugin root. It compares the branch against
its **merge base** with the base branch, so you see only what this branch changed
— not unrelated commits that landed on the base since it was created.

This opens diffs for visual review. It does **not** analyse the code; the built-in
`/review` command does that.

## Locating the script

The scripts live at the **plugin root**, the grandparent of the directory holding
this `SKILL.md` — `../../scripts/vsreview.ps1` relative to this file. Resolve it to
an absolute path first. Do **not** use `${PLUGIN_ROOT}`; it is not expanded in
skill bodies.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\vsreview.ps1" [args]
```

## Choosing arguments

| Situation | Argument |
|---|---|
| Review the current branch | *(none)* |
| Against a specific base | `-Base origin/develop` |
| Review another branch | `-Head feature/x` |
| Limit to some paths | `-Path "src/"` |
| More than 10 changed files | `-MaxFiles 25` |
| VS Code stable instead | `-Editor code` |

The base branch defaults to the first of `origin/main`, `origin/master`, `main`,
or `master` that exists.

## After running

Report the base, head and how many diffs opened. If the script reports no changes,
the branch matches its base — say so rather than opening anything.

If output was capped, mention it and offer `-MaxFiles` or `-Path`.
