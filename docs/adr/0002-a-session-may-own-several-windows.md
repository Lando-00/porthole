# A session may own several windows

Supersedes [0001](0001-session-owned-windows-fail-closed.md).

Tour presentation and explicit-target precedence are amended by
[0003](0003-owned-targets-and-tour-publications.md). The remainder of this
document records the original multi-window decision.

Ownership is defined by the artifact, not by a count: **whatever Copilot session
folder is open in a window, that session owns that window.** A session may own
more than one, and asking for another window is a legitimate thing to do rather
than a conflict to refuse.

0001 read the same ownership rule as "exactly one window per session" and made
two matching windows an `ambiguous` refusal. That refusal was not scoped to
`/cops`: it came from `chooseCompanion`, so it turned off *every* route for that
session — `goto`, `annotate`, tours, reviews, even `ping` — with no way out
except naming a `windowId` by hand. A second window is usually deliberate, and
it left the session unable to talk to the first one.

Among the windows a session owns, the **oldest is the primary**; any opened
afterwards is a secondary. Age comes from `startedAt`, which is fixed for an
extension host's lifetime — `updatedAt` could not be used, because it is
refreshed on every handled request. When the primary closes, the next oldest
becomes primary on its own: no election, no stored state, nothing to go stale.

Routing follows from what a route does:

- **Visual** routes — reveal/goto, annotate, annotate-clear, tour display — go
  to every owned window, so a session spread across two windows sees its own
  work in both. The primary's ack is the answer; a secondary that fails is
  reported, not fatal.
- **Everything else** — a preview's Apply prompt, a workspace edit, a deletion,
  a query expecting one answer — goes to the primary alone. Doing these twice is
  either destructive or meaningless.
- An explicit `windowId` always wins and never broadcasts.

## Consequences

Fail-closed now covers **cross-session** and genuinely undecidable routing, which
is the part that prevents damage: a window holding a different session's folder
is still refused, and repository matching is still metadata rather than routing
authority. What is no longer refused is a session talking to windows it owns.

`ambiguous` survives for cases that remain undecidable — several unbound windows
with no session evidence, or several legacy companions — and is no longer
reachable through same-session matches.

The cost is that "one window per session" stops being enforced and becomes only
what `auto` produces. A user who forces extra windows gets annotations echoed
into all of them, and has to know that the oldest is where single-answer
operations land. That is reported in the result rather than left implicit.
