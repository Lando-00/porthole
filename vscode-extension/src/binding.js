function samePath(left, right) {
    const normalise = (value) =>
        String(value || "")
            .replace(/[\\/]+$/, "")
            .toLowerCase();
    return normalise(left) === normalise(right);
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

    return { clear };
}

module.exports = { createSessionBinding, samePath };
