# opensession

A [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/copilot-cli/about-copilot-cli)
plugin that opens your **current project** and your **current Copilot CLI session
folder** together in a **single** VS Code / VS Code Insiders workspace.

```
/open-session      →   one editor window
/cops                  ├── opensession-plugin              (your repo / worktree)
                       └── Copilot Session (eeb847a2)      (~/.copilot/session-state/<id>/)
```

Stop alt-tabbing between your code and the session artifacts the agent is
writing. They live in one window.

## Commands

| Command | Description |
|---|---|
| `/open-session` | Open project + current session folder in one workspace |
| `/cops` | Short alias for the same thing |

### Arguments

| Invocation | Behaviour |
|---|---|
| `/open-session` | Prefers VS Code Insiders, falls back to VS Code |
| `/open-session insiders` | Force VS Code Insiders |
| `/open-session code` | Force VS Code stable |

## Install

```shell
copilot plugin marketplace add Lando-00/opensession-plugin
copilot plugin install opensession@opensession-marketplace
```

<details>
<summary>Installing from a local clone</summary>

```shell
copilot plugin install ./opensession-plugin
```

Direct installs from local paths, repos, and URLs still work, but the CLI prints
a deprecation warning — `plugin@marketplace` is the supported route going
forward. See [Local development](#local-development) for the reinstall caveat.

</details>

Verify:

```shell
copilot plugin list
copilot skill list
```

## Requirements

- GitHub Copilot CLI (developed and verified against **1.0.77**)
- `code` or `code-insiders` on your `PATH`
- `git` on your `PATH` (optional — non-repo folders work fine)

## How it works

1. Resolves the **project root** with `git rev-parse --show-toplevel`, falling
   back to the current directory when you are not in a repository. Linked git
   worktrees correctly resolve to the *worktree* root, not the main repo.
2. Resolves the **current session folder**. The agent passes its own session path
   directly; if unavailable, the script falls back to the most recently modified
   directory under `$COPILOT_HOME/session-state` (default `~/.copilot`).
3. Writes a `.code-workspace` file listing **both** folders as named roots.
4. Launches the editor on that workspace file, detached, so your CLI session
   never blocks.

The workspace file is written to your system temp directory —
`%TEMP%\opensession-workspaces\` or `$TMPDIR/opensession-workspaces/` — so it is
**never** written into your repository and can never be committed by accident.
Its filename is deterministic per project + session, so re-running reuses the
same workspace instead of piling up duplicates.

## Running the script directly

The scripts are plain and work standalone, without the plugin:

```powershell
# Windows
.\scripts\open-session.ps1 -SessionPath <session folder> [-ProjectPath <path>] [-Editor auto|insiders|code] [-DryRun]
```

```bash
# macOS / Linux
./scripts/open-session.sh --session <session folder> [--project <path>] [--editor auto|insiders|code] [--dry-run]
```

`-DryRun` / `--dry-run` builds and reports the workspace file without launching
an editor — handy for testing.

## Layout

```text
opensession-plugin/
├── plugin.json                        # manifest
├── skills/
│   ├── open-session/SKILL.md          # /open-session
│   └── cops/SKILL.md                  # /cops
├── scripts/
│   ├── open-session.ps1               # Windows
│   └── open-session.sh                # macOS / Linux
└── .github/plugin/marketplace.json    # lets this repo act as its own marketplace
```

## Local development

Plugin components are **cached** at install time. After editing files, refresh
the cache:

```shell
copilot plugin install ./opensession-plugin
```

> **Windows caveat (CLI 1.0.77):** reinstalling *over* an existing direct install
> fails reproducibly with `Access is denied. (os error 5)`, and
> `copilot plugin uninstall` fails the same way. Remove the cached copy first:
>
> ```powershell
> Remove-Item "$env:USERPROFILE\.copilot\installed-plugins\_direct\opensession-plugin" -Recurse -Force
> copilot plugin install ./opensession-plugin
> ```

Alternatively, skip the cache entirely and load the plugin straight from disk:

```shell
copilot --plugin-dir ./opensession-plugin
```

### Note on `${PLUGIN_ROOT}`

`${PLUGIN_ROOT}` is **not** expanded inside `SKILL.md` bodies — it is only
resolved in MCP and LSP server configuration. The skills here therefore locate
the scripts relative to the skill file (`../../scripts/`) instead.

## License

[MIT](LICENSE)
