# Keep Tour presentation local and original evidence durable

This amends ADR 0002: a session may still own several windows, but publishing or
activating a Tour targets its primary window by default or one explicitly
selected owned window. Saved Tours remain session-owned; choosing a window
controls presentation, not ownership. An explicit window ID narrows the owned
set and never overrides a conflicting session binding.

Broadcasting a Tour surprised readers by navigating another window they were
using independently. The other visual broadcasts remain useful, but run
concurrently within one shared deadline instead of accumulating secondary waits.

Authored Tour data and current progress have separate lifetimes. Publication
captures the source evidence; cursor autosaves write only progress for that
publication. This prevents navigation in an older window from overwriting a
refreshed explanation and avoids rewriting the whole Tour on every step.

Porthole reports an advisory local revision change on demand. The model and user
decide whether the explanation needs updating: matching text is not proof of
semantic correctness. We retain existing restore-time anchoring rather than add
a continuous freshness monitor, full source snapshots or Tour version history.

Delivery retries deduplicate only within one bounded live-companion operation.
Older pairs remain explicitly legacy single-shot; a missing acknowledgement or
replacement host cannot be described as proof that an effect never happened.
