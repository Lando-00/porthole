// Where we are: the project folder, its git head, and the small path rules
// that go with storing findings about it.
//
// Reviews and tours both save things that point at a repository and want to
// survive being reopened somewhere else, so both need to answer the same
// questions: which folder is the project (as opposed to the session folder we
// were opened alongside), what commit was this written against, and is this
// path allowed.
//
// It lives here rather than in either of them because reviews already imports
// tours - putting it in reviews would make that a cycle.

const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { sessionRoot } = require("./session");

/**
 * The project folder in this window.
 *
 * /cops opens the project and the session folder side by side, so "the first
 * workspace folder" is not good enough - it may well be the session folder.
 * The one that is not underneath session-state is the project.
 */
function projectFolder() {
    const root = sessionRoot().toLowerCase();
    const folder = (vscode.workspace.workspaceFolders || [])
        .map((f) => f.uri.fsPath)
        .find((p) => !p.toLowerCase().startsWith(root));
    return folder || null;
}

/** Reads .git directly, which is cheaper and more predictable than shelling out. */
function gitHead(dir) {
    try {
        const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
        const ref = /^ref:\s*(.+)$/.exec(head);
        if (!ref) return { branch: null, commit: head.slice(0, 7) };
        const branch = ref[1].replace(/^refs\/heads\//, "");
        let commit = null;
        try {
            commit = fs
                .readFileSync(path.join(dir, ".git", ref[1]), "utf8")
                .trim()
                .slice(0, 7);
        } catch {
            commit = null;
        }
        return { branch, commit };
    } catch {
        return { branch: null, commit: null };
    }
}

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Stored relative to the repository where possible, so a tour or review still
 * makes sense if the checkout moves.
 */
function storedPath(file, repo) {
    return repo && isInside(repo, file) ? path.relative(repo, file) : file;
}

function absoluteFile(file, repo) {
    if (path.isAbsolute(file)) return file;
    if (repo) return path.join(repo, file);
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    return folder ? path.join(folder.uri.fsPath, file) : file;
}

/** A filename-safe, url-safe, human-readable id. */
function normaliseSlug(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^\w-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

module.exports = {
    projectFolder,
    gitHead,
    isInside,
    storedPath,
    absoluteFile,
    normaliseSlug,
};
