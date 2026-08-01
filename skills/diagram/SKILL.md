---
name: diagram
description: >-
    Create a mermaid diagram and open it rendered in VS Code / VS Code Insiders. Use when
    the user runs /diagram, or asks to draw, visualise, chart or diagram something - an
    architecture, a flow, a sequence, a state machine, an ER diagram or a git graph.
user-invocable: true
metadata:
  author: Lando-00
  version: 0.2.0
---

# Create and render a mermaid diagram

Writes `<name>.diagram.md` into the current session folder's `files/` directory
and opens it **rendered**, not as source.

Mermaid rendering is built into VS Code, so nothing needs installing. The script
opens a generated workspace whose `workbench.editorAssociations` maps
`*.diagram.md` to `vscode.markdown.preview.editor` — that association is what
makes the file open rendered, because there is no CLI flag to trigger the
"open preview" command.

## Locating the script

The scripts live at the **plugin root**, the grandparent of the directory holding
this `SKILL.md` — `../../scripts/diagram.ps1` relative to this file. Resolve it to
an absolute path first. Do **not** use `${PLUGIN_ROOT}`; it is not expanded in
skill bodies.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin root>\scripts\diagram.ps1" -Name "<short-kebab-name>" -Title "<human readable title>" -SessionPath "<current session folder>" -Mermaid "<mermaid source>"
```

Pass the current session folder explicitly with `-SessionPath`; you know it from
your own context.

## Writing the mermaid source

Author the diagram yourself from what the user asked for.

- Pass the source **without** the surrounding mermaid code fence — the script
  adds it. (A fence is stripped if you include one anyway.)
- If the source is long, or contains quoting that is awkward to escape on the
  command line, write it to a temp file and use `-MermaidFile <path>` instead.
  This is usually the more reliable route for anything non-trivial.
- Pick the right diagram type: `graph`/`flowchart`, `sequenceDiagram`,
  `classDiagram`, `stateDiagram-v2`, `erDiagram`, `gitGraph`, `mindmap`.
- Keep node labels short; put detail in edge labels.

## After running

Report the diagram path and confirm it opened rendered. If the user asks for
changes, edit the same file and re-run with the same `-Name` so it is replaced
rather than duplicated.
