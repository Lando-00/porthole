// Diagnostics log for the porthole companion.
//
// A URI handler is otherwise impossible to observe: when nothing happens you
// cannot tell whether the extension is inactive, the URI never arrived, or the
// payload was wrong. Off by default now that every route acks - the ack is the
// primary signal and this is only for digging into the awkward cases.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOG_FILE = path.join(os.tmpdir(), "porthole-companion.log");

let enabled = false;

function refreshFromSettings(vscode) {
    try {
        enabled = vscode.workspace.getConfiguration("porthole").get("diagnostics", false);
    } catch {
        enabled = false;
    }
}

function diag(message) {
    if (!enabled) return;
    diagAlways(message);
}

/** Written regardless of the setting: activation failures leave no other trace. */
function diagAlways(message) {
    try {
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Diagnostics must never break the extension.
    }
}

module.exports = { diag, diagAlways, refreshFromSettings, LOG_FILE };
