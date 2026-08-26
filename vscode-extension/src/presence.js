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
// judge liveness by probing the pid, never by the file's age or its name - a
// window nobody has touched for an hour is still perfectly alive. The pid in
// the legacy filename and record is only a liveness hint; windowId is the
// stable address for this host lifetime.
//
// The write after each handled request keeps the record of a window that is in
// use ahead of one left over from a previous boot, because readers sort
// newest-first. A stale record is outranked rather than deleted - see
// docs/PROTOCOL.md, "Presence is a hint; the ack is the proof".

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { diag } = require("./log");

// One address per extension-host lifetime. Do not derive this from the pid:
// pids can be reused, while the inbox is deliberately addressed by windowId.
const WINDOW_ID = crypto.randomBytes(8).toString("hex");
let findWorkspaceSession = null;

function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), ".copilot");
}

function heartbeatDir() {
    return path.join(copilotHome(), "porthole");
}

function heartbeatPath() {
    // Keep the filename compatible with older CLI readers; windowId in the
    // record, not this pid-derived filename, is the routing identity.
    return path.join(heartbeatDir(), `companion-${process.pid}.json`);
}

function describe(vscode, version, contract = {}) {
    let session = null;
    try {
        if (!findWorkspaceSession) {
            findWorkspaceSession = require("./session").findWorkspaceSession;
        }
        session = findWorkspaceSession();
    } catch (err) {
        diag(`session lookup failed while publishing presence: ${err.message}`);
    }

    let identity = { state: "unbound" };
    try {
        identity = require("./identity").identity();
    } catch (err) {
        diag(`identity lookup failed while publishing presence: ${err.message}`);
    }

    return {
        windowId: WINDOW_ID,
        pid: process.pid,
        version,
        protocolLevel: contract.protocolLevel || null,
        capabilities: Array.isArray(contract.capabilities) ? contract.capabilities : [],
        requiredCliCapabilities: Array.isArray(contract.requiredCliCapabilities)
            ? contract.requiredCliCapabilities
            : [],
        uriScheme: vscode.env.uriScheme,
        appName: vscode.env.appName,
        appHost: vscode.env.appHost,
        // Null when the window is local. A remote window's extension host has a
        // different filesystem, so the CLI cannot reach it - the CLI needs to be
        // able to say that rather than time out on every request.
        remoteName: vscode.env.remoteName || null,
        tmpdir: os.tmpdir(),
        copilotHome: copilotHome(),
        sessionId: session ? session.id : null,
        sessionFolder: session ? session.dir : null,
        sessionLabel: identity.label || null,
        repository: identity.repository || null,
        branch: identity.branch || null,
        connectionHealth: identity.state,
        compatibility:
            identity.state === "incompatible"
                ? {
                      updateTarget: identity.updateTarget,
                      missingCapabilities: identity.missingCapabilities || [],
                  }
                : null,
        sessionColor: identity.color || null,
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

function write(vscode, version, contract = {}) {
    try {
        // Owner-only: this directory carries session metadata and, under
        // inbox/, requests addressed to this window, and under outbox/ the
        // user's selected source code.
        fs.mkdirSync(heartbeatDir(), { recursive: true, mode: 0o700 });
        const file = heartbeatPath();
        const tmp = `${file}.tmp`;
        fs.writeFileSync(
            tmp,
            JSON.stringify(describe(vscode, version, contract), null, 2),
            { encoding: "utf8", mode: 0o600 },
        );
        fs.renameSync(tmp, file);
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
function start(vscode, context, version, contract = {}) {
    write(vscode, version, contract);

    context.subscriptions.push(
        // Only on focus. The contents cannot change on the way *out* of a
        // window, so writing then just doubled the heartbeat traffic of every
        // alt-tab. Freshness on the window actually being used is what the
        // newest-first readers need, and handling a request republishes too.
        vscode.window.onDidChangeWindowState((event) => {
            if (event.focused) write(vscode, version, contract);
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => write(vscode, version, contract)),
        { dispose: remove },
    );

    return WINDOW_ID;
}

module.exports = {
    start,
    write,
    remove,
    heartbeatPath,
    heartbeatDir,
    describe,
    windowId: () => WINDOW_ID,
};
