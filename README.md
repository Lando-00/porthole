# porthole

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Lando-00.porthole-companion?label=companion&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Lando-00.porthole-companion)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Lando-00.porthole-companion)](https://marketplace.visualstudio.com/items?itemName=Lando-00.porthole-companion)

A window from your [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/copilot-cli/about-copilot-cli)
session into VS Code.

Ask Copilot to show you something, and it appears in your editor — diffs,
diagrams, files at a line, scratch notes — **in the window you already have open**.

And when Copilot explains code, it can **annotate the lines it is talking about**
while it writes, or **walk you through them step by step** — so the explanation
and the code are the same conversation. Selections travel the other way too:
send code from the editor straight into the session.

Each session window identifies itself in the status bar with the session name,
repository, branch, connection health, and a stable session colour. That makes
it obvious which CLI conversation owns the window before you start editing.

## What you would use it for

| You want to… | Try |
|---|---|
| Understand why a bug happens, across several files | `/walkthrough why the retry loop never exits` |
| Review a PR with more than one thread in it | Ask for a walkthrough per thread — auth, error handling, migration |
| Find your way around an unfamiliar module | `/walkthrough how a request reaches the database` |
| Pick up a review from last week | `/porthole tours` — saved walkthroughs come back, and say which steps went stale |
| Stop the agent guessing at compile errors | `/problems` — it reads what your language server actually reports |
| Ask about the code in front of you | Select it, `Ctrl+Alt+.` |
| See the whole thing on your own code | `/porthole example` |
| Review risky edits before they land | Ask Copilot to preview the proposed changes in VS Code |
| Bring this session's editor back | Ask Copilot to focus this session's VS Code window |

`/walkthrough` opens an editor window if none is running. Nothing else does —
porthole never takes over your screen unless you asked it to.

## Commands

Two kinds, deliberately:

**Deterministic** — real extension commands. The CLI calls a handler directly:
same behaviour every time, no model in the loop, no tokens spent.

| Command | What it does |
|---|---|
| `/cops` · `/open-session` | Reuse this session's own window, or open a separate one for it |
| `/cops dry-run` | Preview it: which editor, whether a window is reused, every path — **without opening or writing anything** |
| `/cops no-plan` | Same, but don't auto-open the session's `plan.md` |
| `/vsdiff` | Diffs: no args = uncommitted; or a commit, a range, `staged`, or two file paths |
| `/goto <file:line:col>` | Jump to a position |
| `/goto <file:start-end>` | **Select and highlight a range** (needs the companion extension) |
| `/goto <symbolName>` | Select a function, class or constant **by name**, whole body |
| `/annotate <file:start-end> [note]` | Leave a marked, hoverable note on those lines |
| `/annotate-clear` | Remove every annotation |
| `/problems` | What VS Code is reporting right now: errors, warnings, type errors |
| `/reviews` | List saved review findings; `load <name>` to bring one back |
| `/porthole tours` | What walkthroughs exist, and which have gone stale |
| `/tour-exit` | Stop walking the active tour (it stays in the library) |
| `/porthole help` | Every command, grouped, with examples |
| `/porthole example` | **Have Copilot demonstrate porthole on your own code** |
| `/porthole` | Diagnose everything: config, editors, connected windows, companion, session, git |

**Agent-driven** — skills, where interpretation is the point.

| Command | What it does |
|---|---|
| `/walkthrough <what>` | **Copilot builds a narrated, steppable tour of the code you name** |
| `/diagram` | You describe it, Copilot writes the mermaid, it opens **rendered** |
| `/vsreview` | Open every file changed on a branch as diffs |
| `/scratch` | Create/open a scratch note in the session folder |

> `/diff` and `/review` are already built-in Copilot CLI commands, hence
> `/vsdiff`, `/vsreview` and `/reviews`.

## Tools Copilot can call

Eleven tools are registered with the agent, so it can drive your editor mid-answer
without you typing anything.

| Tool | What it does |
|---|---|
| `porthole_annotate` | Marks the exact lines it is describing, with a message on hover |
| `porthole_goto` | Opens a file, a range or a symbol, optionally annotating it |
| `porthole_tour` | A narrated, ordered walkthrough you step through with Next/Prev |
| `porthole_tours` | Lists the walkthrough library, and says which ones have gone stale |
| `porthole_tour_manage` | Switches, closes or deletes a walkthrough by id |
| `porthole_problems` | Reads your Problems panel, so it stops guessing at compile errors |
| `porthole_review` | Saves findings and loads them back, even in a later session |
| `porthole_open_session` | Opens automatically, forces a new window, or reuses one exact window — only when asked |
| `porthole_windows` | Lists live porthole windows so Copilot can ask which one you mean |
| `porthole_focus_window` | Requests attention from one exact session window without changing its workspace |
| `porthole_preview_changes` | Opens editable proposed-file diffs and applies only after explicit approval |

### Reviewing proposed changes

Ask *"preview these changes in VS Code before applying them"*. Porthole opens a
diff for each file in this session's exact window. The **PROPOSED** side is an
ordinary editable document: adjust it, then choose **Apply reviewed changes** or
**Cancel** from the notification.

Porthole records the original file hashes before opening the preview. It refuses
to apply if a target changed on disk or has unsaved editor changes while you
were reviewing, so approval cannot silently overwrite newer work.

### Focusing the right window

`porthole_focus_window` is addressed by `windowId`, using the same exact-window
inbox as annotations and tours. It never opens a workspace or adds folders. VS
Code does not expose an extension API for forcibly stealing operating-system
focus, so a background window focuses its editor and requests attention; an
already-active window is focused immediately.

Ask *"walk me through how a porthole request reaches VS Code"* and the relevant
ranges light up in the editor as the explanation arrives. Or run
**`/walkthrough`** with what you want explained — the skill behind it also opens
an editor window when none is running, which is the one case where porthole is
allowed to do that on its own.

### A library of walkthroughs

A change worth explaining rarely has one thread. A pull request has the auth
path, the error handling and the migration — so porthole holds **many tours at
once, with one active**.

- The **active** tour owns the gutter, the CodeLenses and the status bar. You
  can only follow one path with your eyes at a time.
- **Every loaded** tour appears in the Problems panel, grouped under its own
  name. The panel becomes the map of the change; the active tour is where you
  are standing in it.
- The **sidebar** lists them all. Click one to walk it; inline buttons stop or
  delete it.
- `Alt+]` / `Alt+[` step through the active tour.

Tours are saved into the session folder automatically, so closing the window
does not lose them, and a later session can pick one up — *"walk me through the
review you saved yesterday"*.

Only tours created by the session bound to a window are restored automatically.
A tour deliberately loaded from another session remains owned by its original
session: walking it updates that original saved copy but does not copy it into
the current session or make it reappear on the next startup.

Because line numbers rot, every step records a hash of the code it was written
about. When a tour is reopened, each step is either found where it was, found
nearby and quietly re-pointed, or **flagged as no longer matching** — in the
gutter, in the sidebar, and in what the agent is told. A walkthrough that has
gone out of date says so rather than confidently describing code that has since
changed.

The useful consequence: a tour **heals from movement but not from rewriting**.
Add a function above a step and the walkthrough catches up silently. Rewrite
what the step was describing and it stays flagged until someone rebuilds it —
because code moving does not invalidate an explanation, and code changing might.

### plan.md opens itself

When the session folder has a `plan.md`, opening the session makes it the active
editor — because the plan is what you were about to read anyway. `no-plan` opts
out for a single run.

The mechanism differs by path, and the difference is not cosmetic: `--add` and
`--goto` in the same invocation silently drop the `--goto`, so when reusing a
window the reveal is a separate step, routed through the companion so it is
acknowledged rather than assumed.

## Sending code back

`Ctrl+Alt+.` in VS Code — or right-click → **porthole: Send selection to
Copilot** — sends the selected code, its location, any errors reported on those
lines, and an optional question straight into the running CLI session as a
prompt.

It waits for the session to confirm receipt, so it never claims to have sent
something that did not arrive.

### Why the split

A skill is a markdown file of instructions: Copilot reads it, then decides what
to run. That flexibility is essential for `/diagram` — something has to author
the mermaid from a sentence. It is pure overhead for `/cops`, which always does
exactly one thing.

So `/cops`, `/goto` and `/vsdiff` are registered by the bundled extension as
`CommandDefinition` handlers instead. The extension is plain Node with no
PowerShell dependency, and its command handler receives the real `sessionId`,
so the session folder is resolved exactly rather than guessed at.

> **Extension commands need the TUI.** They are registered with the interactive
> session, so in a non-interactive `copilot -p "/cops"` run the text is treated
> as an ordinary prompt. Use them from an interactive session.

## Install

```shell
copilot plugin marketplace add Lando-00/porthole
copilot plugin install porthole@porthole-marketplace
```

Then the companion VS Code extension — annotations, walkthroughs,
Problems-panel access, saved reviews, symbol lookup and the sidebar all live
there:

```shell
code-insiders --install-extension Lando-00.porthole-companion
```

or find **porthole companion** in the Extensions view.

Verify everything with `/porthole` in an interactive session.

## Where to start

```
/porthole example
```

Copilot picks something real in your project, builds a narrated walkthrough of
it, and marks it up — so you learn what porthole is for by watching it happen on
code you already know, rather than by reading about it.

`/porthole help` lists everything else. And in VS Code, the companion opens a
short getting-started walkthrough the first time it runs.

> **The first time `/cops` opens a new window, VS Code may ask whether you trust
> the workspace.** Say yes — until you do, VS Code disables every extension,
> porthole included, and does so silently. Choosing the **parent folder**
> (`~/.copilot/session-state`) means it never asks again, because trust covers
> a folder's subfolders and the workspace files inside them.

<details>
<summary>Building the companion from source instead</summary>

```shell
cd vscode-extension
npm run install-local
```

A newly installed build is picked up by a **new window**, not a reload — VS Code
resolves extension versions when a window loads.
</details>

## Updating

```shell
copilot plugin update porthole@porthole-marketplace
```

The companion updates itself from the Marketplace like any other extension.

The plugin checks its Marketplace version when each Copilot session loads. The
lookup is cached for 24 hours and times out quickly; network failures stay
silent. When a newer version exists, Porthole shows an ephemeral warning with
the installed/latest versions and the safe update command. This logic ships
inside the plugin extension—there is no separate hook or updater to install.

> **Run the plugin update from a terminal with no Copilot CLI session open.**
> A running session holds the plugin directory open, and the update replaces it
> wholesale — from inside a session it fails with `Access is denied (os error 5)`,
> which does not say what is actually wrong.

## Configuration

Optional, at `~/.copilot/porthole.json`. Copy
[`porthole.example.json`](porthole.example.json) and keep what you need.

```jsonc
{
  "editor": "insiders",        // insiders | stable | cursor | windsurf | auto | an absolute path
  "preferConnectedIde": true,  // prefer the editor build Copilot is connected to
  "workspaceDir": null,        // where generated workspace and diff files go; null = temp
  "companionTimeoutMs": 2000,  // how long to wait for the companion to answer
  "sendMode": "enqueue",       // selections from VS Code: enqueue | immediate
  "goto": { "symbolFallback": true }
}
```

Editor precedence, highest first:

1. `PORTHOLE_EDITOR`
2. `editor` in the config
3. the launcher used by a connected IDE, when `preferConnectedIde` is on
4. Insiders, then stable

A standing preference beats the connected editor build on purpose: someone who wrote
down "always stable" means it. A broken config never breaks a command — it falls
back to defaults and tells you once.

## Requirements

- GitHub Copilot CLI (developed against **1.0.77**)
- `code-insiders` or `code` on your `PATH` — Insiders is preferred by default
- `git` on your `PATH` (optional; non-repo folders still work)

> **Windows is the tested platform.** The code is written to be portable and
> uses no shell-specific tooling, but macOS and Linux have not been verified.
> A VS Code window running over WSL, SSH or in a container cannot see the CLI's
> filesystem; porthole detects that and says so rather than timing out.
- Node 22+ for the sidebar's task list (used only if the editor cannot read
  SQLite itself)

## One task, one window

`/cops` treats the current Copilot session as the window identity. If that
session already has a porthole window, it reuses it. Otherwise it opens the
generated workspace with VS Code's hard `--new-window` flag — even when another
session already has VS Code open.

The companion publishes a random `windowId`, its bound Copilot `sessionId`, and
its workspace folders. Every companion-backed tool targets that exact session
window, so two sessions in the same repository do not exchange annotations,
tours, or Problems-panel results.

For deliberate exceptions, ask Copilot in normal language:

```text
Use cops, but open a new window.
Use cops and add this session to my unbound scratch window.
```

The model can list live windows and target one exact `windowId`. If several
windows might match a reuse request, it asks instead of guessing. A window
already bound to another Copilot session is refused rather than turned into a
two-session workspace that the sidebar and saved-tour state cannot represent.
`/cops` itself stays deterministic and always uses the safe automatic policy.

Copilot CLI's IDE lock files still choose the editor build to launch, so an
Insiders session is not handed to stable VS Code. `PORTHOLE_EDITOR` and the
`editor` config key override that preference.

Check what porthole sees right now with `/porthole`, or standalone:

```powershell
.\tests\probe-ide.ps1
```

## The companion extension

`code --goto file:line:col` places a **cursor**. The VS Code CLI cannot select a
range, annotate code, resolve a symbol, or tell you whether any of it worked.
The companion in [`vscode-extension/`](vscode-extension/) does all four from
inside the window, and adds a sidebar showing the session and its task list.

```shell
cd vscode-extension
npm run install-local     # packages the VSIX and installs it into Insiders
```

New builds are picked up by **new windows**; reload an existing one.

### How they talk

Both directions, each with a receipt. The full contract is in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

**CLI → one exact editor window:**

```
1. CLI selects   the companion bound to this Copilot session
2. CLI writes    ~/.copilot/porthole/inbox/<windowId>/<requestId>.json
3. that window   reads the request and acts
4. companion     writes <tmp>/porthole/ack/<requestId>.json  ->  { ok, result, ... }
5. CLI polls     for the ack, then reports what actually happened
```

**Editor → CLI:**

```
1. companion     writes ~/.copilot/porthole/outbox/<endpointId>/<messageId>.json
2. CLI claims    it by renaming it into inflight/  (atomic: at most once)
3. CLI calls     session.send({ prompt, mode: "enqueue" })
4. CLI writes    ~/.copilot/porthole/outbox-ack/<messageId>.json
5. companion     reports delivered, or plainly says it could not confirm
```

No socket and no listening port. The companion watches only its own owner-only
inbox. Manual and old-client URI requests remain supported, but normal tool
traffic uses the addressed inbox because a VS Code URI can select an editor
build, not a particular window within that build.

The return path lives under `~/.copilot` rather than the temp directory
on purpose. `/tmp` is shared between local users on Linux and macOS, and this is
the one channel that turns a file into a prompt for an agent that can run shell
commands.

Each side publishes a presence file — `companion-<pid>.json` and
`cli-<endpointId>.json` — so either can find the other, and prune it, without
paying for `code --list-extensions`. Editor windows are addressed by `windowId`;
CLI processes are addressed by `endpointId`. Session ids remain routing metadata
because a resumed session can have two live CLI processes sharing one id.

Two details worth knowing, both found the hard way:

- **`--open-url` needs the `.exe`, not the `bin/` shim.** Driving it through
  `code-insiders.cmd` blocks and never delivers the URI.
- **The extension activates on `onStartupFinished`, not just `onUri`.** `onUri`
  alone did not reliably wake it, so the handler would not be registered when
  the URI arrived.

Without the companion nothing breaks: ranges degrade to a plain jump, and
porthole says so rather than pretending.

## Diagrams

Mermaid rendering is **built into VS Code** — the `mermaid-markdown-features`
extension ships with the product, so there is nothing to install.

Getting a file to open *rendered* is the harder part: the CLI has no
"open preview" flag. porthole uses the `workbench.editorAssociations` setting to
map `*.diagram.md` to `vscode.markdown.preview.editor`.

- In a porthole-generated workspace, that association is already set.
- When reusing **your** window, the association has to live in your user
  settings. Register it once:

```powershell
.\scripts\setup.ps1 -RegisterDiagramPreview
```

That adds a single key, backs up `settings.json` first, and is reversible with
`-Remove`. Without it, diagrams still open — just as source, until you press
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>.

## Why not `git difftool`?

Because it hangs the agent. `git difftool` deletes its temporary files as soon as
the command returns, so it must block until you close the editor — measured at
120s+ before being killed.

porthole materialises both sides of every diff into a persistent temp directory
and launches the editor detached. Added and deleted files diff against an empty
placeholder so they still render.

## Running the scripts directly

Every script works standalone, without the plugin:

```powershell
.\scripts\open-session.ps1 -SessionPath <folder> [-ForceWorkspace] [-DryRun]
.\scripts\vsdiff.ps1       [-Ref <commit|range|staged>] [-Files a,b] [-Path <filter>] [-MaxFiles 25]
.\scripts\vsreview.ps1     [-Base origin/main] [-Head <branch>] [-MaxFiles 25]
.\scripts\diagram.ps1      -Name <name> -Mermaid "<source>" [-MermaidFile <path>] [-ForcePreviewWorkspace]
.\scripts\goto.ps1         -Target "src/app.ts:42:9" [-NewWindow]
.\scripts\scratch.ps1      [-Name <note>] [-Content "..."] [-Rendered]
.\scripts\setup.ps1        [-RegisterDiagramPreview] [-Remove] [-Flavour insiders|code|both]
```

All of them accept `-Editor auto|insiders|code` and `-DryRun`.

`open-session.sh` provides the POSIX equivalent of `/open-session`. The remaining
scripts are PowerShell; on macOS and Linux run them with `pwsh`.

## Layout

```text
porthole/
├── plugin.json
├── porthole.example.json           # copy to ~/.copilot/porthole.json
├── extensions/porthole/
│   ├── extension.mjs               # commands, tools, registration
│   └── lib/
│       ├── config.mjs              # ~/.copilot/porthole.json, editor precedence
│       ├── editor.mjs              # IDE locks, launcher resolution, detached launch
│       ├── companion.mjs           # payload/ack transport to the VS Code companion
│       ├── annotate.mjs            # annotations, symbol goto, the agent tools
│       ├── doctor.mjs              # /porthole
│       └── git.mjs
├── vscode-extension/               # the VS Code companion
│   ├── extension.js                # URI router
│   ├── src/                        # transport presence reveal annotations symbols session views
│   ├── media/                      # gutter icons, sidebar icon, sqlite reader
│   └── README.md
├── skills/                         # agent-driven commands
│   ├── walkthrough/  diagram/  vsreview/  scratch/
├── scripts/                        # standalone PowerShell equivalents
│   ├── common.ps1                  # IDE detection, editor routing, git helpers
│   ├── open-session.ps1  open-session.sh
│   ├── vsdiff.ps1     vsreview.ps1
│   ├── diagram.ps1    goto.ps1     scratch.ps1
│   └── setup.ps1
├── tests/probe-ide.ps1             # what does porthole see right now?
└── .github/plugin/marketplace.json # this repo is its own marketplace
```

The extension and the scripts implement the same behaviour independently: the
extension is what the slash commands use, the scripts are for running by hand
(and for the agent-driven skills).

## Local development

Components are cached at install time, so reinstall to pick up edits:

```shell
copilot plugin install porthole@porthole-marketplace
```

**Extensions are discovered at session startup.** After reinstalling, start a
*new* session — `extensions_reload` does not pick up a newly installed plugin
extension in an already-running session.

> **Windows caveat (CLI 1.0.77):** reinstalling over an existing *direct* install
> fails with `Access is denied. (os error 5)`, and `copilot plugin uninstall`
> fails the same way. `marketplace remove --force` also leaves the cached plugin
> directory behind, which makes the *next* install fail the same way even though
> the plugin no longer appears in `plugin list`. If you hit it:
>
> ```powershell
> Remove-Item "$env:USERPROFILE\.copilot\installed-plugins\porthole-marketplace" -Recurse -Force
> copilot plugin install porthole@porthole-marketplace
> ```

Or skip the cache entirely:

```shell
copilot --plugin-dir ./porthole
```

### `${PLUGIN_ROOT}` doesn't work in skills

It is only expanded in MCP and LSP configuration — **not** in `SKILL.md` bodies.
The skills here locate scripts relative to the skill file (`../../scripts/`)
instead. This fails silently if you get it wrong: the literal string reaches the
agent, which then guesses at a path.

## License

[MIT](LICENSE)
