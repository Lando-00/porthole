# Changelog

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
