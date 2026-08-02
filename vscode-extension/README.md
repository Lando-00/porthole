# porthole companion

The VS Code half of [porthole](https://github.com/Lando-00/porthole), a GitHub
Copilot CLI plugin.

The CLI can ask VS Code to open a file at a line. It cannot select a range,
leave a note on the code it is explaining, resolve a symbol, or tell you whether
any of that worked. This extension does those things from inside the window.

Install the CLI plugin as well — on its own this extension has nothing to talk
to.

## What it adds

**Annotations.** The agent marks the exact lines it is describing: a coloured
underline, a gutter icon, an overview-ruler mark, and a hover carrying its
explanation in markdown. Annotations persist until they are cleared or replaced,
survive closing and reopening the file, and a status bar item shows the count
and jumps between them.

**Range selection.** A real multi-line selection, not just a cursor.

**Symbol resolution.** `/goto handleGoto` selects the whole function, using the
language server when it is warm and a definition scan when it is not.

**A sidebar.** The current Copilot session, the project and branch, plan.md and
checkpoints, and the agent's task list grouped by status with its dependencies.

## Install

```bash
npm run install-local     # packages the VSIX and installs it into Insiders
```

or grab the `.vsix` from a
[release](https://github.com/Lando-00/porthole/releases) and:

```bash
code-insiders --install-extension porthole-companion-<version>.vsix
```

Newly installed builds are picked up by **new windows**; reload an existing one.

## How the CLI talks to it

One direction only: the CLI fires a URI at the editor, and the editor writes a
reply to a file. No socket, no listening port, nothing running in the
background.

```
1. CLI writes    <tmp>/porthole/req/<requestId>.json     the payload
2. CLI fires     vscode-insiders://lando-00.porthole-companion/<route>?req=<requestId>
3. companion     reads the payload, deletes it, does the work
4. companion     writes <tmp>/porthole/ack/<requestId>.json  ->  { ok, ... }
5. CLI polls     for the ack, then reports what actually happened
```

Step 5 is the point. A URI is fire-and-forget, so without an ack a missing
companion looks exactly like a working one — spawning the launcher always
"succeeds".

Each window also writes `~/.copilot/porthole/companion-<pid>.json` while it is
running, so the CLI can find a live companion and its URI scheme without paying
for `code --list-extensions`. Entries whose process is gone are ignored.

Two Windows details worth knowing, both learned the hard way:

- `--open-url` must be handed the executable (`Code - Insiders.exe`). The
  `bin\code-insiders.cmd` shim blocks and never delivers the URI.
- The URI authority is the lower-cased extension id: `lando-00.porthole-companion`.

## Routes

Every route acks, including unknown ones.

### `ping`

No payload. Acks with the window's identity — used by `/porthole` to prove the
companion is reachable and to measure the round trip.

```jsonc
{ "ok": true, "pid": 28556, "version": "0.2.0", "uriScheme": "vscode-insiders",
  "appName": "Visual Studio Code - Insiders", "hostSqlite": true,
  "workspaceFolders": ["c:\\Dev\\porthole"] }
```

### `reveal`

Opens a file and selects a range. Accepts a payload, or the legacy query form:

```
vscode-insiders://lando-00.porthole-companion/reveal?file=C%3A%5Ca.js&start=10&end=20
```

| field | meaning |
| --- | --- |
| `file` | absolute path (required) |
| `start` | 1-based start line (required) |
| `end` | 1-based end line (defaults to `start`) |
| `startCol`, `endCol` | 1-based columns; `endCol` defaults to the end of the line |
| `preserve` | keep an existing flash instead of replacing it |

Acks `{ ok, file, startLine, endLine, style }`.

### `clear`

No payload. Removes the reveal flash.

### `annotate`

```jsonc
{
  "title": "Why /cops opened nothing",   // shown in the status bar tooltip
  "clearExisting": true,                  // default; false adds to the current set
  "focus": 0,                             // which annotation to scroll to
  "annotations": [
    {
      "file": "C:/repo/extension.mjs",
      "startLine": 223,
      "endLine": 240,                     // optional, defaults to startLine
      "startCol": 1, "endCol": null,      // optional
      "severity": "info",                 // info | warn | error | note
      "message": "**This** spawns the editor. Markdown is allowed."
    }
  ]
}
```

Acks `{ ok, applied, total, files, rejected? }`. An entry without a `file` is
rejected with a reason; an unknown severity falls back to `info`.

Hovers are rendered with `isTrusted = false`: the text comes from a model, and a
trusted markdown string can embed command links.

### `annotate-clear`

No payload. Removes every annotation.

### `symbol`

```jsonc
{ "query": "handleGoto", "file": "extension.mjs", "preferKind": "function",
  "message": "This is where /goto is handled.", "severity": "info" }
```

Only `query` is required. With a `message` the resolved range is annotated
instead of merely revealed, so a jump and its explanation are one action.

Acks `{ ok, file, startLine, endLine, name, kind, source, candidates? }` where
`source` is `language-server` or `text-scan`. Equally good matches in different
files ack as `{ ok: false, error: "'x' is ambiguous", candidates: [...] }` —
jumping to an arbitrary one would be worse than saying so.

## Commands

| Command | Does |
| --- | --- |
| `porthole: Clear annotations` | Removes every annotation |
| `porthole: Next annotation` / `Previous annotation` | Steps through the set |
| `porthole: List annotations` | Quick-pick to jump to one (also the status bar click) |
| `porthole: Clear highlight` | Removes the reveal flash |
| `porthole: Refresh session and tasks` | Reloads the sidebar |
| `porthole: Show reveal URI for the current selection` | Copies a reveal URI to the clipboard |

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `porthole.highlight.style` | `both` | `selection`, `flash`, or `both` |
| `porthole.highlight.flashDurationMs` | `2500` | `0` keeps the flash until cleared |
| `porthole.annotations.gutterIcons` | `true` | Gutter icon beside each annotated range |
| `porthole.annotations.autoRevealFocus` | `true` | Scroll to the focused annotation on arrival |
| `porthole.diagnostics` | `false` | Log to `<tmp>/porthole-companion.log` |

Turn on `porthole.diagnostics` when a porthole command appears to do nothing; it
applies immediately, without a reload.

## The sidebar

**Session** — the session id, the project and its branch, `plan.md`, and the
checkpoint count. Items open what they name.

**Tasks** — the agent's todo list grouped by status (`in progress`, `pending`,
`blocked`, `done`), with the description as a tooltip and `depends on:` children
for blocked work.

Both read the session folder, found either from a workspace folder under
`~/.copilot/session-state` (what `/cops` produces) or from a session holding a
live `inuse.<pid>.lock`. `session.db` is read read-only via `node:sqlite`,
falling back to whatever `node` is on your PATH.

Refreshing happens on demand, when a view becomes visible, and when the window
regains focus. There is no file watcher and no polling.

## Licence

MIT
