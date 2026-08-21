// Workspace-folder operations that must run in the selected VS Code window.
//
// The CLI cannot safely use `--add` once it has selected an already-open
// window: that flag is addressed to whichever editor the launcher chooses.
// Running the update through this companion keeps the operation in the exact
// window whose presence record was selected.

const path = require("node:path");

function pathValues(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { error: "workspace-add requires a payload object" };
    }

    const names = ["folders", "folder", "path", "folderPath"].filter(
        (name) => Object.prototype.hasOwnProperty.call(payload, name),
    );
    if (names.length === 0) {
        return { error: "workspace-add requires an absolute folder path" };
    }
    if (names.length > 1) {
        return { error: "workspace-add accepts one folder list" };
    }

    const value = payload[names[0]];
    const values = names[0] === "folders" ? value : [value];
    if (!Array.isArray(values) || values.length === 0) {
        return { error: "workspace-add requires an absolute folder path" };
    }

    const folders = [];
    for (const item of values) {
        if (typeof item !== "string" || !item.trim()) {
            return { error: "workspace-add requires absolute folder paths" };
        }
        const folder = item.trim();
        if (folder.includes("\0") || !isAbsolute(folder)) {
            return { error: "workspace-add requires absolute folder paths" };
        }
        if (!folders.some((existing) => comparable(existing) === comparable(folder))) {
            folders.push(folder);
        }
    }

    return { folders };
}

function isAbsolute(value) {
    // `path.isAbsolute` is authoritative for the running extension host. The
    // extra forms keep validation correct in tests and when a URI is received
    // before a remote path provider has normalised its separators.
    return (
        path.isAbsolute(value) ||
        /^[A-Za-z]:[\\/]/.test(value) ||
        value.startsWith("\\\\")
    );
}

function comparable(value) {
    let normal = path.normalize(value);
    if (normal.length > 1 && !/^[A-Za-z]:[\\/]$/.test(normal)) {
        normal = normal.replace(/[\\/]+$/, "");
    }
    return process.platform === "win32" ? normal.toLowerCase() : normal;
}

function existingFolders(vscode) {
    return (vscode.workspace.workspaceFolders || [])
        .map((entry) => entry && entry.uri && entry.uri.fsPath)
        .filter((folder) => typeof folder === "string")
        .map(comparable);
}

function add(vscode, payload) {
    const parsed = pathValues(payload);
    if (parsed.error) return { ok: false, error: parsed.error };

    const existing = new Set(existingFolders(vscode));
    const folders = parsed.folders.filter((folder) => {
        const key = comparable(folder);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
    });

    if (folders.length === 0) {
        return { ok: true, added: false, folders: [] };
    }

    const current = vscode.workspace.workspaceFolders || [];
    const result = vscode.workspace.updateWorkspaceFolders(
        current.length,
        0,
        ...folders.map((folder) => ({ uri: vscode.Uri.file(folder) })),
    );
    if (result === false) {
        return { ok: false, error: "VS Code refused to add the workspace folders" };
    }
    return { ok: true, added: true, folders };
}

// The route accepts both { folders: [...] } and the single-folder spelling.
// All execution still goes through one updateWorkspaceFolders call.
module.exports = { add, isAbsolute, pathValue: pathValues };
