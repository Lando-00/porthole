# Session-owned windows fail closed

> **Superseded by [0002](0002-a-session-may-own-several-windows.md).** The
> ownership rule stands; the "exactly one window" part of it does not.

A Porthole window is owned by one exact Copilot session, even when several
sessions use the same repository. The CLI extension selects by session identity
and refuses absent, ambiguous, incompatible, or cross-session routing rather
than guessing from repository or active-window state; this trades convenience
for preventing one task's explanations and artifacts from entering another
task's editor context.

## Consequences

Repository matching is metadata, not routing authority. Opening or adopting a
window requires explicit user intent, a disconnected binding survives process
exit, and the companion validates requests inside the addressed window rather
than broadening their target.
