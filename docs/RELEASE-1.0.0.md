# Porthole 1.0.0 release handoff

## Release summary

Porthole 1.0 makes Copilot session identity the authority for VS Code window
routing, connection health, Tours and Saved Reviews. It adds capability
negotiation, durable Session Binding, exact-window focus, guarded editable
Change Preview, session-owned artifact libraries, explicit discovery/import,
Archive/Unarchive, and evidence-based legacy cleanup.

## Qualified artifacts

- CLI plugin: `1.0.0`
- VS Code companion: `1.0.0`
- Git tag to create after qualification: `v1.0.0`
- GitHub release asset: `porthole-companion-1.0.0.vsix`
- SHA-256:
  `6C664DBC1E08F3E5BEC7BF68EFFA2F4F5423CF7945F056A588EF9FAE1EA45C15`

## Qualification evidence

- Static validator: passed with plugin and companion `1.0.0`
- Node suite: 58/58 passed on Windows ARM64
- Migration coverage: current, imported, archived, legacy-copy, uncertain,
  Tour and Saved Review fixtures passed together
- Multi-session harness: same-repository exact routing, isolated Tour Libraries,
  scoped deletion, reconnect health and Local Environment refusal passed
- VS Code Stable: installed VSIX and fresh isolated host reported `1.0.0`
- VS Code Insiders: installed VSIX and fresh isolated host reported `1.0.0`

## Publication handoff

1. Push the qualified `main` commit and wait for Windows/Linux CI.
2. Create and push tag `v1.0.0`; do not rewrite it.
3. Verify the GitHub release contains `porthole-companion-1.0.0.vsix`.
4. If `VSCE_PAT` cannot publish, upload that exact VSIX at
   <https://marketplace.visualstudio.com/manage/publishers/Lando-00>.
5. Verify the public companion and Porthole Copilot marketplace both report
   `1.0.0`.

## Safe update

Exit every running Copilot CLI session before updating the plugin:

```shell
copilot plugin update porthole@porthole-marketplace
```

A running session holds the installed plugin directory open on Windows and can
cause `Access is denied (os error 5)`. After the companion updates, open a new
VS Code window; existing windows continue running the version they loaded.
