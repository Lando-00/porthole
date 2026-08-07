# porthole companion

The VS Code half of [porthole](https://github.com/Lando-00/porthole), a GitHub
Copilot CLI plugin.

Copilot CLI can already ask VS Code to open a file at a line. It cannot select a
range, leave a note on the code it is explaining, walk you through a change step
by step, read what your language server is reporting, or take a selection back
into the conversation. This extension does those things from inside the window.

> **This extension does nothing on its own.** It is one half of a pair — install
> the CLI plugin too:
>
> ```shell
> copilot plugin marketplace add Lando-00/porthole
> copilot plugin install porthole@porthole-marketplace
> ```
>
> Then run `/porthole` in an interactive Copilot CLI session to check both halves
> can see each other.

**Requires Windows** for the CLI half at present; macOS and Linux launcher
support is not there yet.

## What it adds

**Annotations.** The agent marks the exact lines it is describing: a coloured
underline, a gutter icon, an overview-ruler mark, and a hover carrying its
explanation in markdown. Annotations persist until they are cleared or replaced,
survive closing and reopening the file, and a status bar item shows the count
and jumps between them. They are also published to the **Problems panel**, so
they are navigable with F8 and filterable like any other finding.

**Reading the Problems panel.** The agent can ask what the language servers and
linters are actually reporting, rather than guessing at compile errors from the
source. Its own annotations are excluded from that answer.

**Walkthrough mode.** An ordered, narrated tour of a code path, with the
narration and controls in a CodeLens above each step, gutter markers showing
progress, and the whole path in the sidebar. `Alt+]` / `Alt+[` to step.

**A library of walkthroughs.** Many tours loaded at once, one active. The active
one owns the gutter and the lenses; every loaded one appears in the Problems
panel under its own name, so a pull request with three threads reads as three
tours rather than one fifty-step list. Tours are saved into the session folder
automatically and restored when the window reopens — and, because line numbers
rot, each step carries a hash of the code it was written about, so a tour that
has gone out of date says so instead of describing whatever now sits there.

**Saved reviews.** Save the current findings and load them again later, even
from a different session. Findings carry a hash of the code they describe, so a
review that has gone stale says so instead of marking innocent lines.

**Send to Copilot.** `Ctrl+Alt+.` sends the selection, its location, any
diagnostics on those lines and an optional question back into the running CLI
session as a prompt.

**Range selection.** A real multi-line selection, not just a cursor.

**Symbol resolution.** `/goto handleGoto` selects the whole function, using the
language server when it is warm and a definition scan when it is not.

**A sidebar.** The current Copilot session, the project and branch, plan.md and
checkpoints, the agent's task list grouped by status, and the tour library.

## Install

From the Marketplace — the Extensions view, or:

```shell
code --install-extension Lando-00.porthole-companion
code-insiders --install-extension Lando-00.porthole-companion
```

Or grab the `.vsix` from a
[release](https://github.com/Lando-00/porthole/releases):

```shell
code-insiders --install-extension porthole-companion-<version>.vsix
```

To build it yourself:

```shell
npm run install-local     # packages the VSIX and installs it into Insiders
```

> **A newly installed build is picked up by a _new window_, not a reload.**
> VS Code resolves extension versions when a window loads, so reloading the
> extension host respawns the version you already had. If an update appears to
> have done nothing, this is why.

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

### `diagnostics`

```jsonc
{ "scope": "open", "severities": ["error", "warning"], "limit": 100 }
```

`scope` is `open` (the default — visible editors), `workspace`, or `file` with a
`file`. Acks `{ ok, result: { files, counts, annotations, truncated, scanned } }`.

porthole's own annotations are excluded from `files` and reported as
`annotations`, so the agent cannot read its own explanation back as a finding.
Entries are sorted worst-first before `limit` is applied.

`open` is the useful default: the language server has definitely looked at
what is on screen, whereas a cold workspace may never have been indexed.

### `tour`

```jsonc
{ "tourId": "auth-path",              // optional; derived from the title
  "title": "how a request reaches the editor",
  "activate": true,                   // start walking it now, default true
  "replace": true,                    // false refuses an id already loaded
  "steps": [ { "file": "src/tour.js", "startLine": 120, "endLine": 145,
               "stepTitle": "the entry point", "narration": "...",
               "severity": "info" } ] }
```

1–50 steps per tour, up to 30 tours loaded. `file` may be absolute or relative
to a workspace folder, and must exist — a step that cannot be resolved is
reported in `result.skipped`, never silently dropped. Acks
`{ ok, result: { tourId, replaced, steps, active, library, skipped } }`.

### `tour-list` / `tour-activate` / `tour-delete`

`tour-list` takes `{ includeSteps, repo, limit }` and merges what is loaded with
what is saved across **every** session folder, so a later session can find an
earlier one's walkthroughs. Acks `{ tours, activeTourId, loaded }`.

`tour-activate` takes `{ tourId, step }`, loading the tour from disk first if it
is not in memory. Acks the tour plus a `staleness` tally when it came off disk.

`tour-delete` takes `{ tourId }` and removes it from the library *and* from
disk. `tour-exit` — with an optional `{ tourId }` — only stops walking it;
closing is not deleting.

Tours are written to `<sessionDir>/porthole/tours/<tourId>.json` automatically,
debounced, on creation and on every cursor move. Each step stores a hash of the
code it describes, so loading can report it as `resolved`, `shifted` (found
nearby and re-pointed), `changed` or `missing`.

### `review-save` / `review-list` / `review-load`

`review-save` takes `{ slug, title }` and writes the current annotations or tour
to `<sessionDir>/porthole/reviews/<slug>.json`.

`review-list` takes `{ limit, repo }` and scans **every** session folder, so a
later session can find an earlier one's reviews.

`review-load` takes `{ slug }` or `{ file }` and acks
`{ ok, result: { review, resolution } }`, where `resolution` counts findings as
`resolved`, `shifted`, `changed` or `missing`. A `file` must resolve inside a
session's reviews folder or it is refused.

## Commands

| Command | Does |
| --- | --- |
| `porthole: Clear annotations` | Removes every annotation |
| `porthole: Next annotation` / `Previous annotation` | Steps through the set |
| `porthole: List annotations` | Quick-pick to jump to one (also the status bar click) |
| `porthole: Next tour step` / `Previous tour step` | `Alt+]` / `Alt+[` |
| `porthole: List tour steps` | Quick-pick over the active walkthrough |
| `porthole: Switch tour` | Quick-pick over the whole library |
| `porthole: Walk this tour` / `Stop walking this tour` | Also inline in the sidebar |
| `porthole: Delete tour` | Removes it from the library and from disk; confirms first |
| `porthole: Exit tour` | `Alt+Escape` — stops walking, keeps the tour |
| `porthole: Close all tours` | Unloads the library; leaves the files alone |
| `porthole: Save review` / `Load review` | Persist and restore findings |
| `porthole: Send selection to Copilot` | `Ctrl+Alt+.`, also on the editor context menu |
| `porthole: Clear highlight` | Removes the reveal flash |
| `porthole: Refresh session and tasks` | Reloads the sidebar |
| `porthole: Show reveal URI for the current selection` | Copies a reveal URI to the clipboard |

The three tour keybindings only bind while a tour is running.

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `porthole.highlight.style` | `both` | `selection`, `flash`, or `both` |
| `porthole.highlight.flashDurationMs` | `2500` | `0` keeps the flash until cleared |
| `porthole.annotations.gutterIcons` | `true` | Gutter icon beside each annotated range |
| `porthole.annotations.autoRevealFocus` | `true` | Scroll to the focused annotation on arrival |
| `porthole.problems.publish` | `true` | Show annotations and tour steps in the Problems panel. Each is marked on its **first line only**; turn this off for no underline at all |
| `porthole.diagnostics` | `false` | Log to `<tmp>/porthole-companion.log` |

Turn on `porthole.diagnostics` when a porthole command appears to do nothing; it
applies immediately, without a reload.

## The sidebar

**Session** — the session id, the project and its branch, `plan.md`, and the
checkpoint count. Items open what they name.

**Tasks** — the agent's todo list grouped by status (`in progress`, `pending`,
`blocked`, `done`), with the description as a tooltip and `depends on:` children
for blocked work.

**Tours** — every walkthrough loaded in this window. The active one is expanded
and shows where you are in it; the rest are collapsed, and clicking one starts
walking it. A tour whose code has moved on says how many steps are stale, and
those steps carry a warning icon. A single tour skips the folder and shows its
steps directly. Empty until the agent creates one.

Both read the session folder, found either from a workspace folder under
`~/.copilot/session-state` (what `/cops` produces) or from a session holding a
live `inuse.<pid>.lock`. `session.db` is read read-only via `node:sqlite`,
falling back to whatever `node` is on your PATH.

Refreshing happens on demand, when a view becomes visible, and when the window
regains focus. There is no file watcher and no polling.

## Licence

MIT
