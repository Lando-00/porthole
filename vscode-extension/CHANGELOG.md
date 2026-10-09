# Changelog

## Unreleased

- Guarded operations validate the expected session and deduplicate bounded
  retries in the same live host. Older callers retain explicit legacy one-shot
  compatibility; lost confirmation is not proof of non-execution.
- Tours display in one selected session-owned window rather than broadcasting.
- Original anchors and publication metadata survive navigation. Cursor autosaves
  write progress separately from the authored Tour.
- Step presentation requires a saved target buffer. An on-demand repository
  revision advisory leaves explanation refresh decisions to the user and model.
- Promoting existing findings preserves inherited source evidence.

## 1.1.0

- The heartbeat now publishes `startedAt`, so a Copilot session that owns
  several windows can tell which came first. The oldest is the primary and
  answers for the session; later ones are secondaries that still receive
  annotations, `/goto` and tour display.
- A request the CLI has stopped waiting for is dropped instead of being acted
  on, so a command reported as timed out no longer runs a moment later.
- Running in WSL, a Dev Container or a Codespace is no longer treated as a
  fault when the editor and the CLI share a filesystem. `porthole: diagnose`
  reports it as information rather than a failure.

## 1.0.2

Bug fixes.

- One unanswered notification no longer stops the window answering anything
  else. Requests are still claimed in order, but a change preview waiting on
  Apply or Cancel no longer holds up everything behind it.
- Requests are now also polled for, not only watched for, so a home directory
  on a network, roaming or cloud-synced filesystem cannot silently strand them.
- A result that could not be written because a virus scanner briefly locked the
  file is retried rather than discarded, so work the window really did is no
  longer reported as never having happened.
- Saving a review twice no longer overwrites the first one.
- A tour is no longer corrupted when the same Copilot session is open in two
  windows.
- A failed tour import no longer leaves its file behind to reappear later.
- The first-run walkthrough timer no longer fires into a closed window.
- Outboxes left by finished sessions are swept from the home directory.

## 1.0.1

Performance and stalls.

Selections sent to the CLI are picked up in about 4ms instead of waiting up to
a second. A saved tour is restored as soon as the workspace is ready rather
than always 1.5 seconds after the window opens. The heartbeat is no longer
rewritten when the window loses focus, and two Tasks refreshes at once no
longer each start a `node` process to read the session database.

Fixes:

- Falling back to a text search for a symbol is now bounded by time as well as
  file count, and shares one budget across every workspace folder, so it can no
  longer freeze the window on a large project.
- Waiting for a lazy language service is retried on a short ladder under a
  single deadline, instead of a flat 700ms wait that could overrun the CLI's
  own timeout and move the cursor after the request had been given up on.
- Each symbol lookup leaked a timer.

## 1.0.0

**One Copilot session, one Porthole window, one owned artifact library.**
Companion presence now negotiates capabilities and reports Unbound, Connected,
Disconnected or Incompatible health. Session Binding survives CLI exit and can
be explicitly cleared without deleting Tours or Saved Reviews.

Tour listing, restore, activation, autosave and deletion are exact-session
only. Saved Tour Discovery/import creates independent provenance copies;
Archive/Unarchive is durable and distinct from Close/Delete; provable legacy
copies can be imported or cleaned up safely while uncertain records are
preserved.

Saved Reviews now have current-session list/load/delete plus separate
cross-session discovery/import with provenance, safe collision naming and
confirmed replacement. This release also includes session identity UI,
exact-window focus and editable guarded Change Preview.

## 0.7.0

Added a session identity status item showing the session label, repository,
branch and live CLI health, with a stable colour per session.

Added exact-window focus requests. They run through the addressed inbox, focus
the selected window's editor and request attention without opening or changing
the workspace.

Added editable proposed-change previews. Each replacement opens as a
BEFORE/PROPOSED diff; the user can edit the proposal and explicitly apply or
cancel. Application is guarded by dirty-editor and on-disk hash checks so a
stale preview cannot overwrite newer work.

Fixed cross-session tour persistence. An unbound window no longer restores
walkthroughs from whichever CLI session happens to be live, and walking a tour
loaded from an older session no longer copies it into the current session.
Provable legacy copies are left discoverable but are not auto-restored.

Added capability negotiation between independently released plugin and
companion versions. Presence now publishes a protocol level and named
capabilities; unsupported operations fail before delivery with actionable
update guidance. The identity status and CLI window list distinguish Unbound,
Connected, Disconnected and Incompatible windows.

Added an explicit **Clear session binding** action for finished tasks. A
Disconnected Window remains owned by its Copilot session until the user
confirms this action in that exact window. Clearing releases the window without
deleting its Tours or Saved Reviews.

Made the ordinary Tour Library strictly session-owned. Listing, restoration,
activation, autosave and deletion now use only the exact bound Copilot session;
a sibling session's same-repository or same-ID Tour cannot appear, load, change
or be deleted. Resuming restores the cursor without activating a Tour, while a
fork starts empty.

Added explicit Saved Tour Discovery and import. Discovery is read-only and
separate from the Tour Library. Import creates a current-session-owned copy with
source provenance, safe collision naming, and confirmed replacement without
mutating the historical source.

Added durable Archive/Unarchive for session-owned Tours. Archived Tours leave
the active visuals and default library but remain on disk and available through
an explicit archived picker or `includeArchived`. Close, Archive and Delete now
have distinct UI and model-facing actions.

Added safe handling for legacy foreign Tour copies created by older builds.
Saved Tour Discovery reports provable copies and uncertain evidence explicitly;
legacy import preserves the evidence, while confirmed cleanup deletes one exact
copy and refuses uncertain records.

Made Saved Reviews session-owned. Ordinary list/load/delete is exact-session
only; separate discovery reports historical review metadata, and import creates
an independent copy with provenance, safe collision naming and confirmed
replacement.

## 0.6.0

**One Copilot session, one addressed window.** Each companion window now
publishes a random `windowId` plus the Copilot session folder in its workspace.
Normal CLI requests arrive through an owner-only inbox for that exact window,
so two CLI sessions in the same repository no longer exchange annotations,
tours, reviews, or Problems-panel results.

Added the `workspace-add` route for deliberate reuse. It runs inside the window
the user selected instead of relying on `code --reuse-window --add`, which can
only target the last active window. The CLI refuses to add a second Copilot
session to a window already bound to one. URI handling remains available for
manual requests and old CLI versions.

## 0.5.1

**Presence is republished after every request handled.** A stale record is not
deleted merely because one request times out: the window may only be busy, and
deleting its address would make recovery impossible. A working reply refreshes
`updatedAt`, so the live window outranks records left behind by an unclean
shutdown.

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
