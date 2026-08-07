// Showing the getting-started walkthrough, once.
//
// A new install of this extension does nothing visible: it waits for a CLI
// session that may not exist yet, and if you do not already know what /cops is
// there is nothing to tell you. VS Code's own Getting Started page is the right
// place to say so, and it is the place people already look.
//
// Once, though. This is the feature that most easily turns into an annoyance,
// and a tool that reopens a tutorial you have already read is a tool you start
// resenting. The marker lives in globalState, so it survives updates and
// reinstalls of the same profile.

const vscode = require("vscode");

const { diag } = require("./log");

const SHOWN_KEY = "porthole.walkthroughShown";

/**
 * The walkthrough's fully-qualified id.
 *
 * Read from the manifest rather than written out here, because the two have to
 * agree exactly and nothing at runtime would tell you if they stopped: the
 * command that opens a walkthrough that does not exist fails quietly, and VS
 * Code shows its own Welcome page instead - which looks close enough to working
 * that you would not look twice.
 */
function walkthroughId() {
    const manifest = require("../package.json");
    const walkthrough = manifest.contributes?.walkthroughs?.[0];
    if (!walkthrough) return null;
    return `${manifest.publisher}.${manifest.name}#${walkthrough.id}`;
}

async function open() {
    const id = walkthroughId();
    if (!id) throw new Error("no walkthrough is contributed");
    return vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        id,
        // false = open it in the editor area rather than as a side panel, which
        // is what someone who has just installed an extension expects.
        false,
    );
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.gettingStarted", () => open()),
    );

    if (context.globalState.get(SHOWN_KEY)) return;

    // Recorded before opening rather than after. If the command throws - an
    // older VS Code, a walkthrough id that has drifted - the failure is a
    // walkthrough nobody saw, not one that reappears on every window for the
    // rest of time.
    void context.globalState.update(SHOWN_KEY, true);

    // Deferred past activation so it does not fight whatever the window is
    // already restoring, and skipped entirely when a session is already
    // connected: someone mid-conversation with the CLI has evidently worked out
    // how to use this and does not need the tour.
    setTimeout(() => {
        if (vscode.workspace.getConfiguration("porthole").get("gettingStarted.show", true) === false) {
            return;
        }
        open().then(
            () => diag("opened the getting-started walkthrough (first run)"),
            (err) => diag(`could not open the walkthrough: ${err.message}`),
        );
    }, 3000);
}

module.exports = { activate, open };
