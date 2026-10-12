# Changelog

## Unreleased

**A walkthrough of a change remembers which change it explains.**
`porthole_changes` now prints the exact comparison to pass, and `porthole_tour`
takes it as `comparison`, resolved to commit IDs so a branch that moves later
cannot change it. Uncommitted work, like what an autopilot session just did, is
recorded as live working changes since a commit. A comparison that cannot be
resolved here leaves the Tour usable and says why.

**"What changed here?" is one click.** `porthole_tour_manage` gains `diff`,
which opens a step's Step diff in VS Code without moving the Tour, in the same
window the Tour is walked in. `porthole_changes` and the comparison accept
`<commit>^!` for a single commit's own changes.

**Selections can carry their history.** Sending with history renders each
group as "last changed by", never authorship, with uncommitted and unsaved
lines labelled. Requires Porthole companion 1.3.0.

## 1.3.0

Requires Porthole companion 1.2.0 for the full guarantees; older companions keep
working in legacy single-shot mode and say so.

**Tours stay in the window you chose.** Presentation uses the session's primary
window by default, or an explicitly selected owned window. The library remains
session-owned. An explicit window ID can no longer bypass a conflicting binding.

**Navigation preserves the explanation's original evidence.** Publication
captures anchors once; cursor autosaves keep progress separately. A step requires
its target file to be saved, and an on-demand advisory reports repository
revision changes without claiming that the narration is incorrect.

**Delivery distinguishes uncertainty from failure.** Updated pairs deduplicate
bounded retries within the same live companion. Broadcast waits share one
deadline. Older pairs remain visibly legacy single-shot, without the new retry
and receiver-side ownership guarantees.

**Large changes return an inventory instead of overrunning a patch buffer.**
File status and line-count accounting includes changes that cannot become Tour
steps. Historical coordinates are labelled evidence for the model to interpret
against current saved code, not guaranteed ready-to-display locations.

## 1.2.0

**A walkthrough of a change now starts from the change.** Asking to be walked
through a pull request, a branch, or what Copilot just did used to mean Copilot
going looking for the changed code first — slow, and it could quietly leave a
changed file out of the walkthrough with nothing to tell you. It now reads the
diff before it starts, so every changed hunk is either explained or deliberately
left out, and it will say how many it left out.

Files Copilot created but has not committed are included, which is usually the
most interesting part of what an autopilot session did. Lockfiles, build output
and binaries are left out. A deleted file is named but never walked, because
there is no longer anything to point at.

A pull request has to be checked out first. If it is not, porthole refuses and
gives you the `gh pr checkout` command rather than building a walkthrough from
line numbers that do not match the files on your screen — that walkthrough would
point confidently at unrelated code, and you would have no way to tell.

## 1.1.0

**Porthole now works inside WSL, Dev Containers and Codespaces.** Running the
CLI in the same environment as VS Code was refused outright, with advice to do
the thing you were already doing. What actually matters is whether both halves
see the same filesystem, so that is what is checked now. The genuinely split
setup — CLI on the host, editor attached to a remote — was already reported as
"no window running", and still is.

**A Copilot session can own more than one VS Code window.** Opening a second
window for a session used to disable *every* porthole command for it, not just
`/cops`. Now the first window is the primary and answers for the session;
anything you open afterwards joins as a secondary. Annotations, `/goto` and
tours appear in all of them; anything with a consequence — a change preview,
adding folders, deleting a tour — happens once, in the primary. Naming a window
explicitly still targets exactly that one, and a window belonging to a
*different* session is still refused.

**A command you were told had timed out no longer runs anyway.** If the editor
picked up a request just as the CLI gave up on it, the command still went ahead
— so retrying produced two change previews, or added the same folders twice.
The CLI now tells the window it has stopped waiting, and the window drops the
request instead of acting on it.

## 1.0.2

Bug fixes, from an audit of what breaks in ordinary use.

- A window could look dead while it was perfectly healthy. Requests were
  handled one at a time, and a change preview waits for you to click Apply or
  Cancel — so an unanswered notification left every later command unanswered
  too, until it timed out. `/porthole` then reported the window as broken.
- Requests could be stranded entirely on network, roaming or cloud-synced home
  directories, where the mechanism that notices a new request is unreliable.
  There is now a fallback that does not depend on it.
- A command that had already done its work could be reported as having timed
  out, if a virus scanner briefly locked the file used to report the result.
  The model then retried, and the work happened twice.
- After an unclean shutdown and a reboot, porthole could refuse every command
  for a session and never recover, because a leftover record named a process id
  the system had since reused.
- Closing the laptop lid during a change preview no longer consumes the time
  you have to answer it. Previously the CLI gave up while the diff was still on
  screen, and Apply then wrote files it had already reported as not applied.
- Saving a review twice no longer destroys the first one. Untitled saves both
  wanted the same name; the second now gets its own, and says so.
- A tour can no longer be corrupted by having the same Copilot session open in
  two VS Code windows.
- An outbox holding a selection of your source code is no longer left behind in
  your home directory when a session exits.

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
