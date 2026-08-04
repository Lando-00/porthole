# Changelog

## 0.3.0

**Diagnostics bridge, both directions.** Annotations are now published as real
VS Code diagnostics, so they appear in the Problems panel, are navigable with
F8, and can be filtered and sorted like any other finding — the gutter
decorations stay alongside them. The same API answers the other way: a
`diagnostics` route lets the agent read what the language servers and linters
are actually reporting instead of inferring compile errors from source. Our own
entries are filtered out of that read by `source`, and counted separately, or
the agent would read its own explanation back as if the compiler had said it.
Results are severity-ordered before truncation, so a repository with five
hundred errors returns the worst hundred rather than an arbitrary hundred.

**Walkthrough mode.** A `tour` route takes an ordered, narrated list of code
locations and turns it into something you can step through: a CodeLens carrying
the narration and Next/Prev/Exit controls directly above the code, gutter
markers showing done / here / still to come, a status bar position, and a
sidebar view of the whole path. `Alt+]` and `Alt+[` step, `Alt+Escape` exits;
all three are inert unless a tour is running. Steps are resolved up front, and
one whose file cannot be found is reported rather than dropped.

**Saved reviews.** The current annotations or tour can be saved as a review and
loaded again later — including from a *different* session, since loading scans
every session folder. Because line numbers rot, each finding stores a hash of
the text it was written about, and loading reports what still holds per finding:
resolved, shifted (the code moved, and was found again nearby), changed (the
code was rewritten, so the finding is shown but marked stale) or missing.

**Send to Copilot.** `Ctrl+Alt+.`, the editor context menu, or the palette sends
the current selection — with its location, any diagnostics on those lines and an
optional typed question — back into the running CLI session as a prompt. It is
written under the user-owned `~/.copilot` rather than the shared temp directory,
and delivery is confirmed by an ack rather than assumed.

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
