# porthole companion

The VS Code half of [porthole](../README.md).

The VS Code CLI can open a file at a position (`--goto file:line:col`) but it
**cannot select a range**. This extension adds that: it listens for a URI and
selects, reveals and briefly highlights the requested lines in the window you
already have open.

## Install

```powershell
code-insiders --install-extension porthole-companion-0.1.0.vsix
```

Rebuild the `.vsix` after editing:

```powershell
npx @vscode/vsce package
```

## How it is driven

The CLI side opens a URI:

```powershell
code-insiders --open-url "vscode-insiders://Lando-00.porthole-companion/reveal?file=C:\path\to\file.mjs&start=223&end=270"
```

### `/reveal` parameters

| Parameter | Required | Meaning |
|---|---|---|
| `file` | yes | Absolute path |
| `start` | yes | 1-based start line |
| `end` | no | 1-based end line (defaults to `start`) |
| `startCol` | no | 1-based start column |
| `endCol` | no | 1-based end column (defaults to end of the `end` line) |
| `preserve` | no | `1` keeps an existing highlight instead of replacing it |

Out-of-range lines are clamped to the document, so a stale line number reveals
the end of the file rather than silently doing nothing.

### `/clear`

```
vscode-insiders://Lando-00.porthole-companion/clear
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `porthole.highlight.style` | `both` | `selection`, `flash`, or `both` |
| `porthole.highlight.flashDurationMs` | `2500` | Flash lifetime; `0` keeps it until cleared |

`selection` makes a real editor selection, so <kbd>Ctrl</kbd>+<kbd>C</kbd> just
works. `flash` paints a find-match style decoration that fades on its own.

## Commands

| Command | Purpose |
|---|---|
| `porthole: Clear highlight` | Remove the current flash decoration |
| `porthole: Show reveal URI for the current selection` | Copy a ready-made URI for whatever you have selected |

The second one is the quickest way to see the URI format for a real range.

## Notes

- Plain JavaScript against the stable API: no build step, no dependencies.
- `activationEvents: ["onUri"]` means the extension only wakes when a porthole
  URI arrives.
- The URI authority is `<publisher>.<name>`, so it must stay
  `Lando-00.porthole-companion` to match what the CLI side sends.
