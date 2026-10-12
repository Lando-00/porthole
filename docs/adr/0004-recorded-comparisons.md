# Record the comparison a Tour explains

A Tour that explains a change records that change as a Recorded comparison in
its Tour publication. The model passes it explicitly, copying the value
`porthole_changes` printed; Porthole never infers it from an earlier call,
because a session often builds several Tours from different comparisons. The
CLI resolves it with the same rules as `porthole_changes`, to commit IDs, so a
branch that moves later cannot change what was recorded. One comparison
belongs to a whole Tour.

Like the rest of a publication, the comparison is captured once. Progress,
listing, revision advisories and opening a Step diff never rewrite it. Imported
Tours keep it verbatim; a commit missing from the reader's clone is reported
when a Step diff needs it, and Porthole does not fetch or check anything out.

A Step diff puts the saved file on the right by default, not the recorded
target revision. The step's line numbers belong to the saved file, and it is
the code the reader is looking at. When the saved file no longer matches the
target, the diff says so and the recorded revisions are one click away.
Uncommitted changes are recorded as live working changes since a base commit,
labelled as such rather than presented as the exact state that was explained;
storing source snapshots remains out of scope.

Change markers follow the same rule, base against the saved file, and hide
while a buffer has unsaved edits rather than read the buffer.
