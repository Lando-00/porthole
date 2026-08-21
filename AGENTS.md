# Porthole

Porthole connects a Copilot CLI plugin in `extensions/porthole/` to a plain
JavaScript VS Code companion in `vscode-extension/`. Requests must route to the
exact window bound to the current Copilot session; never fall back across
sessions merely because two windows share a repository.

Validate changes with:

```shell
node tests/validate.mjs
node --test tests/*.test.mjs tests/*.test.cjs
```

Windows is the primary tested platform.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `Lando-00/porthole`. See
`docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
