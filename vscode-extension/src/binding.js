const path = require("node:path");

function samePath(left, right) {
    return normalisePath(left) === normalisePath(right);
}

function pathRules(value) {
    return /^[A-Za-z]:[\\/]|^\\\\/.test(String(value || "")) ? path.win32 : path.posix;
}

function normalisePath(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const rules = pathRules(value);
    const absolute = rules.resolve(value);
    const normal = absolute === rules.parse(absolute).root
        ? absolute
        : absolute.replace(/[\\/]+$/, "");
    return rules === path.win32 ? normal.toLowerCase() : normal;
}

function directSessionFolder(value) {
    const normal = normalisePath(value);
    if (!normal) return null;
    const rules = pathRules(normal);
    if (rules.basename(rules.dirname(normal)).toLowerCase() !== "session-state") {
        return null;
    }
    const sessionId = rules.basename(normal);
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return null;
    return { sessionId, sessionFolder: normal };
}

function workspaceBinding(vscode) {
    const folders = vscode?.workspace?.workspaceFolders || [];
    if (!Array.isArray(folders)) return { state: "conflicted", sessionFolders: [] };

    const found = [];
    for (const entry of folders) {
        const value = entry?.uri?.fsPath;
        if (typeof value !== "string" || !value) {
            return { state: "conflicted", sessionFolders: [] };
        }
        const session = directSessionFolder(value);
        if (
            session &&
            !found.some((existing) => existing.sessionFolder === session.sessionFolder)
        ) {
            found.push(session);
        }
    }

    if (found.length === 0) return { state: "unbound", sessionFolders: [] };
    if (found.length > 1) return { state: "conflicted", sessionFolders: found };
    return { state: "bound", ...found[0], sessionFolders: found };
}

function inspectWorkspaceOwnership(vscode, expected = {}) {
    if (
        typeof expected.sessionId !== "string" ||
        !expected.sessionId ||
        typeof expected.sessionFolder !== "string" ||
        !expected.sessionFolder
    ) {
        return { state: "unknown" };
    }
    const expectedFolder = normalisePath(expected.sessionFolder);
    if (
        !expectedFolder ||
        pathRules(expectedFolder).basename(expectedFolder).toLowerCase() !==
            expected.sessionId.toLowerCase()
    ) {
        return { state: "conflicted" };
    }

    const actual = workspaceBinding(vscode);
    if (actual.state !== "bound") return actual;
    if (
        actual.sessionId.toLowerCase() !== expected.sessionId.toLowerCase() ||
        actual.sessionFolder !== expectedFolder
    ) {
        return { ...actual, state: "foreign" };
    }
    return { ...actual, state: "owned" };
}

function createSessionBinding({ vscode, findWorkspaceSession, sessionLabel }) {
    if (!vscode?.workspace || !vscode?.window) throw new TypeError("vscode host is required");
    if (typeof findWorkspaceSession !== "function") {
        throw new TypeError("workspace session lookup is required");
    }
    if (typeof sessionLabel !== "function") throw new TypeError("session label is required");

    async function clear() {
        const session = findWorkspaceSession();
        if (!session) {
            vscode.window.showInformationMessage("porthole: this window is already unbound.");
            return { ok: true, cleared: false, reason: "unbound" };
        }

        const folders = vscode.workspace.workspaceFolders || [];
        const index = folders.findIndex((folder) => samePath(folder.uri.fsPath, session.dir));
        if (index < 0) {
            return {
                ok: false,
                cleared: false,
                error: "the bound Copilot session folder is no longer in this workspace",
            };
        }

        const label = sessionLabel(session);
        const answer = await vscode.window.showWarningMessage(
            `Clear the Session Binding for "${label}"?`,
            {
                modal: true,
                detail:
                    "This releases this VS Code window. The session's Tours and Saved Reviews remain on disk.",
            },
            "Clear binding",
        );
        if (answer !== "Clear binding") {
            return { ok: true, cleared: false, cancelled: true, sessionId: session.id };
        }

        const currentSession = findWorkspaceSession();
        const currentFolders = vscode.workspace.workspaceFolders || [];
        const currentIndex = currentFolders.findIndex((folder) =>
            samePath(folder.uri.fsPath, session.dir),
        );
        if (
            !currentSession ||
            currentSession.id !== session.id ||
            !samePath(currentSession.dir, session.dir) ||
            currentIndex < 0
        ) {
            const error = "the Session Binding changed while confirmation was open";
            vscode.window.showWarningMessage(`porthole: ${error}; nothing was cleared.`);
            return { ok: false, cleared: false, error };
        }

        const changed = vscode.workspace.updateWorkspaceFolders(currentIndex, 1);
        if (!changed) {
            const error = "VS Code refused to remove the Copilot session folder";
            vscode.window.showWarningMessage(`porthole: ${error}.`);
            return { ok: false, cleared: false, error };
        }

        vscode.window.showInformationMessage(
            `porthole: cleared "${label}". This window is now unbound.`,
        );
        return { ok: true, cleared: true, sessionId: session.id };
    }

    return {
        clear,
        inspect: (expected) => inspectWorkspaceOwnership(vscode, expected),
        current: () => workspaceBinding(vscode),
    };
}

module.exports = {
    createSessionBinding,
    inspectWorkspaceOwnership,
    workspaceBinding,
    samePath,
};
