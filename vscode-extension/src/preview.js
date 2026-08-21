const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_FILES = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_AGE_MS = 24 * 60 * 60 * 1000;

function hash(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function validate(payload, workspaceFolders) {
    const changes = payload?.changes;
    if (!Array.isArray(changes) || changes.length === 0) {
        throw new TypeError("changes must contain at least one proposed file");
    }
    if (changes.length > MAX_FILES) throw new TypeError(`at most ${MAX_FILES} files may be previewed`);

    let total = 0;
    const seen = new Set();
    return changes.map((change, index) => {
        if (!change || typeof change !== "object") {
            throw new TypeError(`change ${index + 1} must be an object`);
        }
        if (typeof change.file !== "string" || !change.file.trim()) {
            throw new TypeError(`change ${index + 1} has no file`);
        }
        if (typeof change.content !== "string") {
            throw new TypeError(`change ${index + 1} content must be a string`);
        }
        const bytes = Buffer.byteLength(change.content);
        if (bytes > MAX_FILE_BYTES) {
            throw new TypeError(`change ${index + 1} exceeds the 1 MB file limit`);
        }
        total += bytes;
        if (total > MAX_TOTAL_BYTES) throw new TypeError("preview exceeds the 5 MB total limit");
        const file = path.resolve(change.file);
        const insideWorkspace = (workspaceFolders || []).some((folder) => {
            const relative = path.relative(folder.uri.fsPath, file);
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        });
        if (!insideWorkspace) {
            throw new TypeError(`change ${index + 1} is outside this window's workspace`);
        }
        const key = process.platform === "win32" ? file.toLowerCase() : file;
        if (seen.has(key)) throw new TypeError(`change ${index + 1} repeats ${file}`);
        seen.add(key);
        return { file, content: change.content };
    });
}

function tempRoot() {
    const dir = path.join(os.tmpdir(), "porthole", "previews");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sweepPreviews() {
    const root = tempRoot();
    const cutoff = Date.now() - MAX_PREVIEW_AGE_MS;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        try {
            if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // An open preview on Windows or a racing cleanup is harmless.
        }
    }
}

function safeName(file, index) {
    return `${String(index + 1).padStart(2, "0")}-${path.basename(file).replace(/[^\w.-]/g, "_")}`;
}

async function snapshot(change, dir, index) {
    let before = "";
    let existed = false;
    try {
        before = fs.readFileSync(change.file);
        existed = true;
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }

    const name = safeName(change.file, index);
    const beforeFile = path.join(dir, `BEFORE-${name}`);
    const proposedFile = path.join(dir, `PROPOSED-${name}`);
    fs.writeFileSync(beforeFile, before);
    fs.writeFileSync(proposedFile, change.content, "utf8");

    return {
        ...change,
        existed,
        beforeHash: hash(before),
        beforeFile,
        proposedFile,
    };
}

function unchanged(entry) {
    try {
        return entry.existed
            ? hash(fs.readFileSync(entry.file)) === entry.beforeHash
            : !fs.existsSync(entry.file);
    } catch {
        return false;
    }
}

function dirtyDocument(vscode, file) {
    const target = path.resolve(file).toLowerCase();
    return vscode.workspace.textDocuments.find(
        (document) => document.uri.scheme === "file" &&
            path.resolve(document.uri.fsPath).toLowerCase() === target &&
            document.isDirty,
    );
}

async function apply(vscode, entries) {
    for (const entry of entries) {
        if (dirtyDocument(vscode, entry.file)) {
            return { ok: false, error: `${entry.file} has unsaved editor changes` };
        }
        if (!unchanged(entry)) {
            return { ok: false, error: `${entry.file} changed while the preview was open` };
        }
    }

    const edit = new vscode.WorkspaceEdit();
    for (const entry of entries) {
        const uri = vscode.Uri.file(entry.file);
        const proposedUri = vscode.Uri.file(entry.proposedFile);
        const proposedDocument = await vscode.workspace.openTextDocument(proposedUri);
        if (proposedDocument.isDirty && !(await proposedDocument.save())) {
            return { ok: false, error: `could not save the reviewed proposal for ${entry.file}` };
        }
        const content = proposedDocument.getText();
        if (entry.existed) {
            const document = await vscode.workspace.openTextDocument(uri);
            const end = document.positionAt(document.getText().length);
            edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
        } else {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(entry.file)));
            edit.createFile(uri, { ignoreIfExists: false });
            edit.insert(uri, new vscode.Position(0, 0), content);
        }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return { ok: false, error: "VS Code refused the workspace edit" };

    const saved = [];
    for (const entry of entries) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
        if (!(await document.save())) {
            return { ok: false, error: `could not save ${entry.file}` };
        }
        saved.push(entry.file);
    }
    return { ok: true, applied: true, files: saved };
}

async function preview(vscode, payload) {
    const changes = validate(payload, vscode.workspace.workspaceFolders);
    const title =
        typeof payload?.title === "string" && payload.title.trim()
            ? payload.title.trim().slice(0, 120)
            : "Proposed changes";
    sweepPreviews();
    const dir = fs.mkdtempSync(path.join(tempRoot(), "change-"));
    const entries = [];

    for (const [index, change] of changes.entries()) {
        const entry = await snapshot(change, dir, index);
        entries.push(entry);
        await vscode.commands.executeCommand(
            "vscode.diff",
            vscode.Uri.file(entry.beforeFile),
            vscode.Uri.file(entry.proposedFile),
            `${path.basename(change.file)} — ${title}`,
            { preview: false },
        );
    }

    const choice = await vscode.window.showInformationMessage(
        `porthole: ${title} — review ${entries.length} file change${entries.length === 1 ? "" : "s"}. ` +
            "Edit the PROPOSED side, then apply or cancel.",
        "Apply reviewed changes",
        "Cancel",
    );

    if (choice !== "Apply reviewed changes") {
        return { ok: true, applied: false, cancelled: true, files: entries.map((entry) => entry.file) };
    }
    return apply(vscode, entries);
}

module.exports = { preview, validate, hash, unchanged, apply };
