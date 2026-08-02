// Presence heartbeat.
//
// The CLI needs to know, cheaply and accurately, whether a companion is running
// and which URI scheme to address it with. Shelling out to
// `code --list-extensions` answers the first question only, takes about a
// second, and blocks - so instead each window drops a small file:
//
//   ~/.copilot/porthole/companion-<pid>.json
//
// Readers prune entries whose pid is dead, exactly like the CLI already does
// for its own ~/.copilot/ide/*.lock files, so a crashed window cannot leave a
// lie behind.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { diag } = require("./log");

function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), ".copilot");
}

function heartbeatDir() {
    return path.join(copilotHome(), "porthole");
}

function heartbeatPath() {
    return path.join(heartbeatDir(), `companion-${process.pid}.json`);
}

function describe(vscode, version) {
    return {
        pid: process.pid,
        version,
        uriScheme: vscode.env.uriScheme,
        appName: vscode.env.appName,
        appHost: vscode.env.appHost,
        workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
        updatedAt: new Date().toISOString(),
    };
}

function write(vscode, version) {
    try {
        fs.mkdirSync(heartbeatDir(), { recursive: true });
        fs.writeFileSync(heartbeatPath(), JSON.stringify(describe(vscode, version), null, 2), "utf8");
    } catch (err) {
        diag(`heartbeat write failed: ${err.message}`);
    }
}

function remove() {
    try {
        fs.rmSync(heartbeatPath(), { force: true });
    } catch {
        // ignore
    }
}

/**
 * Starts the heartbeat and keeps it current.
 *
 * Refreshed on the events that can change its contents - window focus and
 * workspace folder changes - rather than on a timer, so an idle window costs
 * nothing.
 */
function start(vscode, context, version) {
    write(vscode, version);

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(() => write(vscode, version)),
        vscode.workspace.onDidChangeWorkspaceFolders(() => write(vscode, version)),
        { dispose: remove },
    );
}

module.exports = { start, write, remove, heartbeatPath, heartbeatDir, describe };
