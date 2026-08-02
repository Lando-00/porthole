# Changelog

## 0.2.0

**Annotations.** The agent can mark the exact lines it is explaining: a coloured
underline, a gutter icon, an overview-ruler mark, and a markdown hover carrying
the explanation. Annotations persist until cleared or replaced and are
re-applied when a file is reopened, which decorations alone do not do. A status
bar item shows the count and opens a quick-pick to jump between them, with
next/previous/clear commands.

**Symbol resolution.** A new `symbol` route resolves a name to its full body
range using the workspace and document symbol providers, ranking candidates and
reporting ambiguity rather than guessing. Because TypeScript loads projects
lazily and answers nothing in a cold window, a definition scan backs it up.

**Sidebar.** A porthole activity-bar container with two views: the current
Copilot session (project, branch, plan.md, checkpoints) and the agent's task
list grouped by status with its dependencies, read read-only from `session.db`.

**Ack protocol.** Every route now writes a result file the CLI can read, so a
missing companion no longer looks identical to a working one. Payloads larger
than a URI query travel as files.

**Presence heartbeat.** Each window writes
`~/.copilot/porthole/companion-<pid>.json` while it runs, so the CLI can find a
live companion, its URI scheme and its capabilities without the blocking cost of
`code --list-extensions`.

**Diagnostics are now opt-in** behind `porthole.diagnostics`; they previously
wrote to the temp folder on every activation of every window.

Internally, `extension.js` is now a thin entry point over `src/`.

## 0.1.0

Initial release: a `reveal` URI route that selects and flashes a range, which
`code --goto` cannot do.
