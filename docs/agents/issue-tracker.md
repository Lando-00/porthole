# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI
from this checkout so it infers `Lando-00/porthole` from the remote.

## Operations

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

When a skill says to publish work, create a GitHub issue. When it asks for a
ticket, read the issue and its comments. Pull requests are not a triage request
surface.

## Dependencies and wayfinding

Use a map issue with linked sub-issues. Prefer GitHub's native issue
dependencies for blocking relationships; if unavailable, put
`Blocked by: #<number>` at the top of the child issue. Claim work by assigning
the issue to the current user. Resolve it by recording the result in a comment
and closing the issue.
