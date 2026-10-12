// Supplies immutable revision text to VS Code diff editors without checking files out.

const path = require("node:path");
const history = require("./history");

const SCHEME = "porthole-rev";

function revisionUri(vscode, { repo, oid, path: relPath }) {
    const displayPath = typeof relPath === "string" && relPath.length > 0
        ? relPath.replaceAll("\\", "/")
        : path.basename(String(relPath || "revision"));
    return vscode.Uri.from({
        scheme: SCHEME,
        path: `/${displayPath.replace(/^\/+/, "")}`,
        query: JSON.stringify({ repo, oid, path: relPath }),
    });
}

class RevisionContentProvider {
    async provideTextDocumentContent(uri) {
        let request;
        try {
            request = JSON.parse(uri.query);
        } catch {
            return "Could not read this revision.";
        }
        if (!request || typeof request.repo !== "string"
            || typeof request.oid !== "string"
            || typeof request.path !== "string") {
            return "Could not read this revision.";
        }
        if (request.oid === "empty") return "";

        const result = await history.readRevisionFile(request.repo, request.oid, request.path);
        if (result.ok) return result.text;
        if (result.reason === "binary") return "Binary file — not shown";
        if (result.reason === "missing-object") {
            return `Commit ${request.oid.slice(0, 7)} is not available in this clone; fetch it to see this side.`;
        }
        if (result.reason === "missing-path") {
            return `${request.path} does not exist at ${request.oid.slice(0, 7)}.`;
        }
        if (result.reason === "too-large") return "File too large to show (over 4 MiB).";
        return "Could not read this revision.";
    }
}

function register(vscode, context) {
    const disposable = vscode.workspace.registerTextDocumentContentProvider(
        SCHEME,
        new RevisionContentProvider(),
    );
    context.subscriptions.push(disposable);
    return disposable;
}

module.exports = {
    SCHEME,
    revisionUri,
    RevisionContentProvider,
    register,
};
