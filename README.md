# porthole

A window from your [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/copilot-cli/about-copilot-cli)
session into VS Code.

Ask Copilot to show you something, and it appears in your editor — diffs,
diagrams, files at a line, scratch notes — **in the window you already have open**.

## Commands

Two kinds, deliberately:

**Deterministic** — real extension commands. The CLI calls a handler directly:
same behaviour every time, no model in the loop, no tokens spent.

| Command | What it does |
|---|---|
| `/cops` · `/open-session` | Open this worktree + the current session folder in one workspace |
| `/vsdiff` | Diffs: no args = uncommitted; or a commit, a range, `staged`, or two file paths |
| `/goto <file:line:col>` | Jump to a position |

**Agent-driven** — skills, where interpretation is the point.

| Command | What it does |
|---|---|
| `/diagram` | You describe it, Copilot writes the mermaid, it opens **rendered** |
| `/vsreview` | Open every file changed on a branch as diffs |
| `/scratch` | Create/open a scratch note in the session folder |

> `/diff` and `/review` are already built-in Copilot CLI commands, hence
> `/vsdiff` and `/vsreview`.

### Why the split

A skill is a markdown file of instructions: Copilot reads it, then decides what
to run. That flexibility is essential for `/diagram` — something has to author
the mermaid from a sentence. It is pure overhead for `/cops`, which always does
exactly one thing.

So `/cops`, `/goto` and `/vsdiff` are registered by the bundled extension as
`CommandDefinition` handlers instead. The extension is plain Node with no
PowerShell dependency, and its command handler receives the real `sessionId`,
so the session folder is resolved exactly rather than guessed at.

> **Extension commands need the TUI.** They are registered with the interactive
> session, so in a non-interactive `copilot -p "/cops"` run the text is treated
> as an ordinary prompt. Use them from an interactive session.

## Install

```shell
copilot plugin marketplace add Lando-00/porthole
copilot plugin install porthole@porthole-marketplace
```

Verify with `copilot plugin list` and `copilot skill list`.

## Requirements

- GitHub Copilot CLI (developed against **1.0.77**)
- `code-insiders` or `code` on your `PATH` — Insiders is preferred by default
- `git` on your `PATH` (optional; non-repo folders still work)

## It reuses your open editor

The headline behaviour. Copilot CLI writes a lock file per connected IDE window
into `~/.copilot/ide/`, recording `ideName`, `pid` and `workspaceFolders`.
porthole reads those locks, skips any whose process is no longer alive, and
prefers the window whose workspace contains the path you are working on.

When a window is found, every command targets **that** window:

- `/open-session` adds the session folder to it with `--add` instead of opening
  a second window on a generated workspace
- `/vsdiff`, `/goto` and `/scratch` open into it with `--reuse-window`
- the matching binary is chosen from `ideName`, so an Insiders session never gets
  hijacked by stable VS Code

With no IDE connected, porthole falls back to launching Insiders (then stable).
Passing `-Editor insiders|code` explicitly always wins.

Check what porthole sees right now:

```powershell
.\tests\probe-ide.ps1
```

## Diagrams

Mermaid rendering is **built into VS Code** — the `mermaid-markdown-features`
extension ships with the product, so there is nothing to install.

Getting a file to open *rendered* is the harder part: the CLI has no
"open preview" flag. porthole uses the `workbench.editorAssociations` setting to
map `*.diagram.md` to `vscode.markdown.preview.editor`.

- In a porthole-generated workspace, that association is already set.
- When reusing **your** window, the association has to live in your user
  settings. Register it once:

```powershell
.\scripts\setup.ps1 -RegisterDiagramPreview
```

That adds a single key, backs up `settings.json` first, and is reversible with
`-Remove`. Without it, diagrams still open — just as source, until you press
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>.

## Why not `git difftool`?

Because it hangs the agent. `git difftool` deletes its temporary files as soon as
the command returns, so it must block until you close the editor — measured at
120s+ before being killed.

porthole materialises both sides of every diff into a persistent temp directory
and launches the editor detached. Added and deleted files diff against an empty
placeholder so they still render.

## Running the scripts directly

Every script works standalone, without the plugin:

```powershell
.\scripts\open-session.ps1 -SessionPath <folder> [-ForceWorkspace] [-DryRun]
.\scripts\vsdiff.ps1       [-Ref <commit|range|staged>] [-Files a,b] [-Path <filter>] [-MaxFiles 25]
.\scripts\vsreview.ps1     [-Base origin/main] [-Head <branch>] [-MaxFiles 25]
.\scripts\diagram.ps1      -Name <name> -Mermaid "<source>" [-MermaidFile <path>] [-ForcePreviewWorkspace]
.\scripts\goto.ps1         -Target "src/app.ts:42:9" [-NewWindow]
.\scripts\scratch.ps1      [-Name <note>] [-Content "..."] [-Rendered]
.\scripts\setup.ps1        [-RegisterDiagramPreview] [-Remove] [-Flavour insiders|code|both]
```

All of them accept `-Editor auto|insiders|code` and `-DryRun`.

`open-session.sh` provides the POSIX equivalent of `/open-session`. The remaining
scripts are PowerShell; on macOS and Linux run them with `pwsh`.

## Layout

```text
porthole/
├── plugin.json
├── extensions/porthole/
│   └── extension.mjs               # deterministic /cops /open-session /vsdiff /goto
├── skills/                         # agent-driven commands
│   ├── diagram/  vsreview/  scratch/
├── scripts/                        # standalone PowerShell equivalents
│   ├── common.ps1                  # IDE detection, editor routing, git helpers
│   ├── open-session.ps1  open-session.sh
│   ├── vsdiff.ps1     vsreview.ps1
│   ├── diagram.ps1    goto.ps1     scratch.ps1
│   └── setup.ps1
├── tests/probe-ide.ps1             # what does porthole see right now?
└── .github/plugin/marketplace.json # this repo is its own marketplace
```

The extension and the scripts implement the same behaviour independently: the
extension is what the slash commands use, the scripts are for running by hand
(and for the agent-driven skills).

## Local development

Components are cached at install time, so reinstall to pick up edits:

```shell
copilot plugin install porthole@porthole-marketplace
```

**Extensions are discovered at session startup.** After reinstalling, start a
*new* session — `extensions_reload` does not pick up a newly installed plugin
extension in an already-running session.

> **Windows caveat (CLI 1.0.77):** reinstalling over an existing *direct* install
> fails with `Access is denied. (os error 5)`, and `copilot plugin uninstall`
> fails the same way. `marketplace remove --force` also leaves the cached plugin
> directory behind, which makes the *next* install fail the same way even though
> the plugin no longer appears in `plugin list`. If you hit it:
>
> ```powershell
> Remove-Item "$env:USERPROFILE\.copilot\installed-plugins\porthole-marketplace" -Recurse -Force
> copilot plugin install porthole@porthole-marketplace
> ```

Or skip the cache entirely:

```shell
copilot --plugin-dir ./porthole
```

### `${PLUGIN_ROOT}` doesn't work in skills

It is only expanded in MCP and LSP configuration — **not** in `SKILL.md` bodies.
The skills here locate scripts relative to the skill file (`../../scripts/`)
instead. This fails silently if you get it wrong: the literal string reaches the
agent, which then guesses at a path.

## License

[MIT](LICENSE)
