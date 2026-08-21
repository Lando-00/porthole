const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { findWorkspaceSession, describeSession } = require("./session");

const COLORS = [
    "charts.blue",
    "charts.green",
    "charts.orange",
    "charts.purple",
    "charts.yellow",
];

let statusBar = null;

function unquote(value) {
    const text = String(value || "").trim();
    if (
        text.length >= 2 &&
        ((text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'")))
    ) {
        return text.slice(1, -1);
    }
    return text;
}

function sessionLabel(session) {
    try {
        const yaml = fs.readFileSync(path.join(session.dir, "workspace.yaml"), "utf8");
        const match = /^name:\s*(.+?)\s*$/m.exec(yaml);
        if (match) return unquote(match[1]);
    } catch {
        // Older sessions may not have workspace metadata.
    }
    return `session ${session.id.slice(0, 8)}`;
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

function matchingEndpoint(sessionId) {
    const configured = process.env.COPILOT_HOME;
    const home =
        configured && fs.existsSync(configured)
            ? configured
            : path.join(require("node:os").homedir(), ".copilot");
    const dir = path.join(home, "porthole");

    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.startsWith("cli-") || !entry.endsWith(".json")) continue;
        try {
            const endpoint = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
            if (
                endpoint.sessionId === sessionId &&
                Number.isInteger(endpoint.pid) &&
                isAlive(endpoint.pid)
            ) {
                return endpoint;
            }
        } catch {
            // A racing atomic rewrite or malformed stale record is not a connection.
        }
    }
    return null;
}

function colourFor(sessionId) {
    let hash = 0;
    for (const char of String(sessionId || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return COLORS[hash % COLORS.length];
}

function identity() {
    const session = findWorkspaceSession();
    if (!session) return { state: "unbound" };

    const info = describeSession(session);
    const endpoint = matchingEndpoint(session.id);
    return {
        state: endpoint ? "connected" : "waiting",
        label: endpoint?.sessionName || sessionLabel(session),
        sessionId: session.id,
        repository: info.project ? path.basename(info.project) : null,
        repositoryPath: info.project,
        branch: info.branch,
        color: colourFor(session.id),
    };
}

function refresh() {
    if (!statusBar) return;
    const current = identity();
    if (current.state === "unbound") {
        statusBar.hide();
        return;
    }

    const healthIcon = current.state === "connected" ? "radio-tower" : "debug-disconnect";
    const repo = current.repository
        ? `${current.repository}${current.branch ? `@${current.branch}` : ""}`
        : null;
    statusBar.text = `$(${healthIcon}) ${current.label}${repo ? ` · ${repo}` : ""}`;
    statusBar.color = new vscode.ThemeColor(
        current.state === "connected" ? current.color : "statusBarItem.warningForeground",
    );
    statusBar.tooltip = [
        `Copilot session: ${current.label}`,
        `Health: ${current.state === "connected" ? "connected" : "waiting for CLI"}`,
        current.repository ? `Repository: ${current.repositoryPath}` : null,
        current.branch ? `Branch: ${current.branch}` : null,
        `Session: ${current.sessionId}`,
        "",
        "Click to open the porthole sidebar.",
    ]
        .filter((line) => line !== null)
        .join("\n");
    statusBar.show();
}

function activate(context) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    statusBar.name = "porthole session identity";
    statusBar.command = "workbench.view.extension.porthole";
    context.subscriptions.push(statusBar);

    refresh();
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((event) => event.focused && refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    );

    for (const delay of [2000, 5000, 10000]) {
        const timer = setTimeout(refresh, delay);
        context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }
}

module.exports = { activate, refresh, identity, sessionLabel, colourFor };
