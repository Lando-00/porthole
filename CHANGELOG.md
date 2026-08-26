# Changelog

## 1.0.1

Performance. Porthole spent a lot of its time waiting on things it could
already see, and repeating work it had already done.

Requests to VS Code are now watched for as well as polled, so a round trip
takes about 4ms instead of 16ms, and a wait that goes the distance costs a
fifth of the system calls. That matters most for a change preview, where the
answer is a human clicking Apply up to half an hour later. A selection sent
from the editor arrives in about 4ms rather than up to a second.

`/cops` no longer sleeps a second before it first checks whether the new window
has come up, and a saved tour is restored as soon as the workspace is ready
rather than always 1.5 seconds later.

Editor and repository lookups are no longer re-run for every file: one `where`
or `git` call costs 55-70ms on Windows, and annotating ten files used to pay
about twenty of them. A failed lookup is never remembered, so installing an
editor or running `git init` mid-session still takes effect.

Fixes:

- A request could be reported as timed out while the companion's own
  acknowledgement was already sitting on disk, so work that had been done was
  reported as never having happened.
- A prompt sent from the editor that never completed could stop every later
  selection from being delivered.
- Waiting on a send could delay the CLI exiting.
- Falling back to a text search for a symbol is now bounded by time as well as
  file count, so it cannot freeze the editor window on a large project.

## 1.0.0

Porthole now treats one exact Copilot session as the owner of one VS Code
window and its durable Session Artifacts. Routing fails closed across
same-repository sessions, with addressed companion transport and capability
negotiation between independently released plugin and companion versions.

Tours are session-owned and persist across resume without leaking into forks or
sibling sessions. Saved Tour Discovery/import creates independent copies with
provenance; Archive is distinct from Close and Delete; legacy foreign copies
are classified and cleaned up only with evidence and confirmation. Saved
Reviews follow the same current-session listing, explicit discovery/import,
provenance, collision and scoped-delete rules.

Also added session identity/health UI, explicit Session Binding release,
exact-window focus, editable guarded Change Preview, startup update notices,
and release-grade Windows/Linux CI.
