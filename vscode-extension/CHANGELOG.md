# Changelog

## 0.5.1

**Presence is republished after every request handled.** The CLI now deletes the
presence file of any window that fails to answer — it cannot otherwise tell a
live VS Code from an unrelated process that inherited its pid after a reboot,
and a power-off leaves those files behind because nothing runs on the way down.
Republishing on reply is what keeps a merely busy window from being forgotten:
a slow answer costs one entry, and the next request restores it.

Also stopped calling any of this a heartbeat. There is no timer and nothing
judges freshness by age — the name invited someone to "fix" a stale entry by
trusting `updatedAt`, which would break every window not focused recently.

## 0.5.0

**A getting-started walkthrough.** Installing this extension used to do nothing
visible: it waits for a Copilot CLI session that may not exist yet, and if you
did not already know what `/cops` was, nothing told you. VS Code's own Getting
Started page now opens once, the first time it runs, with four steps — install
the CLI half, run `/cops`, ask for a walkthrough, and have it demonstrate itself
on your own code.

Each step ticks off from a **context key**, not from you having clicked a link:
`porthole.cliConnected` when a session actually reaches this window,
`porthole.sessionFound` once `/cops` has run, `porthole.tourLibrary` when a tour
really exists. VS Code's `onCommand` completion is documented as unreliable —
steps have been known to complete merely by being looked at — and a checklist
that lies to a new user is worse than no checklist.

Shown **once, ever**, recorded in `globalState` before opening rather than
after, so a failure is a walkthrough nobody saw rather than one that reappears
on every window forever. `porthole.gettingStarted.show` turns it off entirely,
and **porthole: Get started** reopens it deliberately.

## 0.4.1

**Stopped underlining code it was only explaining.** Every annotation and tour
step was published as a diagnostic spanning its whole range, and VS Code draws a
diagnostic as a squiggly underline — which means "something is wrong here" in
every editor anyone has used. A four-step walkthrough therefore covered the code
it was explaining in warning marks, and offered a *Fix* for a piece of
narration. Exactly backwards for a feature whose purpose is making code easier
to read.

The diagnostic now marks the **first line only**. The range was never what it
was for: the gutter icon, the highlight and the CodeLens already show it. What
the diagnostic adds is a row in the Problems panel and somewhere to jump to, and
one line serves both.

**New setting `porthole.problems.publish`** (default on) for anyone who would
rather have no underline at all. Decorations, gutter icons and CodeLenses stay
either way. It applies immediately rather than on reload, because a visual
setting you have to restart to see is one nobody trusts they changed.

## 0.4.0

**A library of tours, not one at a time.** A change worth explaining rarely has
one thread: a pull request has the auth path, the error handling and the
migration. Until now, starting a second tour destroyed the first, and two CLI
sessions sharing a window clobbered each other silently. Tours are now held in a
registry keyed by a short id, and up to thirty can be loaded at once.

Exactly one is **active**. You can only follow one path with your eyes at a
time, and one gutter cannot legibly carry three different "step 1" markers — so
the active tour owns the gutter, the CodeLenses and the status bar, while every
loaded tour publishes into its own diagnostic collection. The Problems panel
becomes the map of a change, grouped by tour name; the active tour is where you
are standing in it.

**Tours survive the window closing.** They are written to
`<sessionDir>/porthole/tours/<tourId>.json` on creation and on every cursor
move, debounced, and this session's tours are restored when the window reopens —
without activating any of them, because reopening a window should show you what
you had, not decide what you are looking at. Tours from other sessions are found
by `tour-list` and loaded on demand, which is what makes "pick up yesterday's
review" work.

**And they admit when they have gone stale.** Every step records a hash of the
code it was written about. On load, each is classified `resolved`, `shifted`
(found nearby and quietly re-pointed), `changed` or `missing`, and the *resolved*
range is what everything downstream is given. A changed step is warned about in
the gutter, in the sidebar, in the hover and in what the agent is told. The
anchoring itself moved into a shared module, since saved reviews had solved the
identical problem and two copies of a staleness check will drift.

**The sidebar shows the library.** Tours at the root, steps beneath, the active
one expanded — with inline actions to walk, stop or delete. A single tour still
shows its steps directly; the folder only earns its place once there is a choice
to make. New: `porthole: Switch tour`, `Close all tours`, `Walk this tour`,
`Stop walking this tour`, `Delete tour`.

**Closing is not deleting.** `Alt+Escape` and `tour-exit` stop walking a tour but
leave it in the library, in the Problems panel and on disk. Only `tour-delete`
removes it, and the sidebar confirms first.

New routes: `tour-list`, `tour-activate`, `tour-delete`. `tour` gains `tourId`,
`activate` and `replace`; `tour-exit` gains an optional `tourId`. Pre-0.4.0
callers are unaffected — a `tour` call without an id still creates and starts a
tour.

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
