const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { findWorkspaceSession, describeSession } = require("./session");
const capabilities = require("./capabilities");

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
    const contract = capabilities.presenceContract();
    const health = capabilities.connectionHealth({
        sessionId: session.id,
        endpoint,
        companionCapabilities: contract.capabilities,
        requiredCliCapabilities: contract.requiredCliCapabilities,
    });
    return {
        ...health,
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
        statusBar.text = "$(debug-disconnect) porthole: unbound";
        statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
        statusBar.tooltip =
            "Health: unbound\n\nNo Copilot session owns this window. Run /cops from a session to bind it.";
        statusBar.show();
        return;
    }

    const healthIcon = {
        connected: "radio-tower",
        disconnected: "debug-disconnect",
        incompatible: "error",
    }[current.state];
    const repo = current.repository
        ? `${current.repository}${current.branch ? `@${current.branch}` : ""}`
        : null;
    statusBar.text = `$(${healthIcon}) ${current.label}${repo ? ` · ${repo}` : ""}`;
    statusBar.color = new vscode.ThemeColor(
        current.state === "connected"
            ? current.color
            : current.state === "incompatible"
              ? "statusBarItem.errorForeground"
              : "statusBarItem.warningForeground",
    );
    const healthText =
        current.state === "incompatible"
            ? `incompatible — update the ${current.updateTarget}`
            : current.state;
    statusBar.tooltip = [
        `Copilot session: ${current.label}`,
        `Health: ${healthText}`,
        current.missingCapabilities?.length
            ? `Missing: ${current.missingCapabilities.join(", ")}`
            : null,
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
