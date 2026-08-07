// Context keys, for the getting-started walkthrough.
//
// VS Code walkthrough steps can tick themselves off from a context key
// (`onContext:`), and that is the only completion event worth using here.
// `onCommand:` is documented as unreliable - steps have been known to complete
// merely by being looked at - and a checklist that lies is worse than no
// checklist, because it tells a new user they have finished something they
// have not started.
//
// So each key is set from evidence that the thing actually happened:
//
//   porthole.cliConnected  a Copilot CLI session has published a presence file
//   porthole.sessionFound  this window can see a session folder, i.e. /cops ran
//   porthole.tourActive    a walkthrough is running   (set by tour.js)
//   porthole.tourLibrary   at least one tour is loaded (set by tour.js)
//
// Refreshed on the same cheap, event-driven schedule as the sidebar: on
// demand, and when the window regains focus. No watcher, no polling, so an
// idle window costs nothing.

const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { diag } = require("./log");
const { findSession } = require("./session");

/** Where the CLI publishes its presence files. Mirrors src/send.js. */
function portholeHome() {
    const configured = process.env.COPILOT_HOME;
    const home =
        configured && fs.existsSync(configured)
            ? configured
            : path.join(require("node:os").homedir(), ".copilot");
    return path.join(home, "porthole");
}

/**
 * Whether any Copilot CLI session is addressable from here.
 *
 * Only a liveness question, so a stale file from a dead process is not worth
 * the effort of pruning: the worst case is a walkthrough step staying ticked
 * after the session ended, which is the harmless direction to be wrong in.
 */
function cliConnected() {
    try {
        return fs
            .readdirSync(portholeHome())
            .some((f) => f.startsWith("cli-") && f.endsWith(".json"));
    } catch {
        return false;
    }
}

const state = { cliConnected: false, sessionFound: false };

function refresh() {
    const next = {
        cliConnected: cliConnected(),
        sessionFound: Boolean(findSession()),
    };

    for (const [key, value] of Object.entries(next)) {
        if (state[key] === value) continue;
        state[key] = value;
        void vscode.commands.executeCommand("setContext", `porthole.${key}`, value);
        diag(`context porthole.${key} = ${value}`);
    }
    return next;
}

function activate(context) {
    // Set explicitly rather than left undefined, so a `when` clause reads false
    // instead of missing.
    for (const key of Object.keys(state)) {
        void vscode.commands.executeCommand("setContext", `porthole.${key}`, false);
    }

    refresh();

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => e.focused && refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
    );

    // The CLI half often connects a moment after the window appears, and
    // nothing in the editor is notified when it does. A handful of early checks
    // covers that without leaving a timer running for the life of the window.
    for (const delay of [2000, 5000, 10000, 20000]) {
        const timer = setTimeout(refresh, delay);
        context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }
}

module.exports = { activate, refresh, cliConnected };
