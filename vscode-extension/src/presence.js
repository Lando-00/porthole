// Presence.
//
// The CLI needs to know, cheaply and accurately, whether a companion is running
// and which URI scheme to address it with. Shelling out to
// `code --list-extensions` answers the first question only, takes about a
// second, and blocks - so instead each window drops a small file:
//
//   ~/.copilot/porthole/companion-<pid>.json
//
// Deliberately NOT a heartbeat: there is no timer, because a periodic write
// means an idle window doing disk I/O forever. It is written on activation, on
// the events that change its contents, and after every request handled. Readers
// judge liveness by probing the pid, never by the file's age - a window nobody
// has touched for an hour is still perfectly alive.
//
// A pid check cannot tell a live window from a pid inherited after a reboot,
// so the CLI deletes any presence file that fails to answer a request. That is
// why the write after each handled request matters: it is how a window that IS
// answering keeps saying so.

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
        // Null when the window is local. A remote window's extension host has a
        // different filesystem, so the CLI cannot reach it - the CLI needs to be
        // able to say that rather than time out on every request.
        remoteName: vscode.env.remoteName || null,
        tmpdir: os.tmpdir(),
        copilotHome: copilotHome(),
        // Whether the editor's own runtime can read session.db, or whether the
        // sidebar has to fall back to spawning `node`. Worth knowing from the
        // outside, because it is the one capability that varies by build.
        hostSqlite: hasHostSqlite(),
        workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
        updatedAt: new Date().toISOString(),
    };
}

let hostSqlite = null;

function hasHostSqlite() {
    if (hostSqlite === null) {
        try {
            require("node:sqlite");
            hostSqlite = true;
        } catch {
            hostSqlite = false;
        }
    }
    return hostSqlite;
}

function write(vscode, version) {
    try {
        // Owner-only: this directory carries session metadata and, under
        // outbox/, the user's selected source code.
        fs.mkdirSync(heartbeatDir(), { recursive: true, mode: 0o700 });
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
 * Starts publishing presence and keeps it current.
 *
 * Refreshed on the events that can change its contents - window focus and
 * workspace folder changes - and after every request handled, rather than on a
 * timer, so an idle window costs nothing.
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
