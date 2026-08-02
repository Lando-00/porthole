// porthole companion
//
// Gives the porthole Copilot CLI plugin the one thing the VS Code CLI cannot do:
// select and highlight a *range*. `code --goto file:line:col` only places a
// cursor, so multi-line highlighting needs an extension running inside the
// window.
//
// The CLI side drives this through a URI, opened with:
//
//   code-insiders --open-url "vscode-insiders://Lando-00.porthole-companion/reveal?file=<abs>&start=223&end=270"
//
// Query parameters for /reveal:
//   file        absolute path (required)
//   start       1-based start line (required)
//   end         1-based end line (optional; defaults to start)
//   startCol    1-based start column (optional)
//   endCol      1-based end column (optional; defaults to end of `end` line)
//   preserve    "1" to keep any existing highlight instead of replacing it
//
// Everything is plain JavaScript against the stable VS Code API, so there is no
// build step and no runtime dependencies.

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Appends a line to a log file in temp.
 *
 * A URI handler is otherwise hard to observe: if nothing happens you cannot
 * tell whether the extension is inactive, the URI never arrived, or the range
 * was wrong. Cheap and only written on activation and on each request.
 */
function diag(message) {
    try {
        const file = path.join(os.tmpdir(), "porthole-companion.log");
        fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Diagnostics must never break the extension.
    }
}

/** Editors that currently show a flash decoration, so they can be cleared. */
let flashDecoration = null;
let flashTimer = null;

function getConfig() {
    const cfg = vscode.workspace.getConfiguration("porthole");
    return {
        style: cfg.get("highlight.style", "both"),
        flashDurationMs: cfg.get("highlight.flashDurationMs", 2500),
    };
}

function ensureFlashDecoration() {
    if (flashDecoration) return flashDecoration;
    flashDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
        border: "1px solid",
        borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
        isWholeLine: false,
        overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
        overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    return flashDecoration;
}

function clearHighlight() {
    if (flashTimer) {
        clearTimeout(flashTimer);
        flashTimer = null;
    }
    if (!flashDecoration) return;
    for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(flashDecoration, []);
    }
}

/** Parses a URI query string into a plain object. */
function parseQuery(query) {
    const out = {};
    if (!query) return out;
    for (const pair of query.split("&")) {
        if (!pair) continue;
        const idx = pair.indexOf("=");
        const key = idx === -1 ? pair : pair.slice(0, idx);
        const value = idx === -1 ? "" : pair.slice(idx + 1);
        out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
    }
    return out;
}

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

async function reveal(params) {
    const filePath = params.file;
    if (!filePath) {
        vscode.window.showErrorMessage("porthole: reveal is missing the 'file' parameter.");
        return;
    }

    const startLine = toInt(params.start, 1);
    const endLine = toInt(params.end, startLine);
    const startCol = toInt(params.startCol, 1);
    const endCol = params.endCol !== undefined ? toInt(params.endCol, 1) : undefined;

    let document;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch (err) {
        vscode.window.showErrorMessage(`porthole: could not open ${filePath} - ${err.message}`);
        return;
    }

    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
    });

    // Clamp to the document. A range past the end would otherwise be silently
    // dropped, which looks like the command doing nothing.
    const lastLine = Math.max(0, document.lineCount - 1);
    const s = Math.min(Math.max(startLine - 1, 0), lastLine);
    const e = Math.min(Math.max(endLine - 1, 0), lastLine);
    const from = Math.min(s, e);
    const to = Math.max(s, e);

    const startCharacter = Math.max(startCol - 1, 0);
    const endCharacter =
        endCol !== undefined ? Math.max(endCol - 1, 0) : document.lineAt(to).text.length;

    const range = new vscode.Range(from, startCharacter, to, endCharacter);
    diag(`reveal ${filePath} lines ${from + 1}-${to + 1}`);

    const { style, flashDurationMs } = getConfig();

    if (style === "selection" || style === "both") {
        editor.selection = new vscode.Selection(range.start, range.end);
    } else {
        editor.selection = new vscode.Selection(range.start, range.start);
    }

    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const sel = editor.selection;
    diag(
        `applied selection ${sel.start.line + 1}:${sel.start.character + 1}-` +
            `${sel.end.line + 1}:${sel.end.character + 1} empty=${sel.isEmpty} style=${style}`,
    );

    if (style === "flash" || style === "both") {
        const decoration = ensureFlashDecoration();
        if (params.preserve !== "1" && flashTimer) {
            clearTimeout(flashTimer);
            flashTimer = null;
        }
        editor.setDecorations(decoration, [range]);

        if (flashDurationMs > 0) {
            flashTimer = setTimeout(() => {
                editor.setDecorations(decoration, []);
                flashTimer = null;
            }, flashDurationMs);
        }
    }
}

function activate(context) {
    diag(`activate pid=${process.pid} scheme=${vscode.env.uriScheme}`);

    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri) {
                // uri.path is "/reveal" for vscode://<id>/reveal?...
                const route = (uri.path || "").replace(/^\/+/, "").toLowerCase();
                const params = parseQuery(uri.query);
                diag(`handleUri route=${route} query=${uri.query}`);

                if (route === "reveal" || route === "") {
                    void reveal(params);
                    return;
                }
                if (route === "clear") {
                    clearHighlight();
                    return;
                }
                vscode.window.showWarningMessage(`porthole: unknown route '${route}'.`);
            },
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.clearHighlight", clearHighlight),
    );

    // Makes the URI format discoverable without reading the source.
    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.showUriExample", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage("porthole: open a file and select a range first.");
                return;
            }
            const sel = editor.selection;
            const scheme = vscode.env.uriScheme; // vscode or vscode-insiders
            const uri =
                `${scheme}://Lando-00.porthole-companion/reveal` +
                `?file=${encodeURIComponent(editor.document.uri.fsPath)}` +
                `&start=${sel.start.line + 1}&end=${sel.end.line + 1}`;
            await vscode.env.clipboard.writeText(uri);
            vscode.window.showInformationMessage("porthole: reveal URI copied to the clipboard.");
        }),
    );

    context.subscriptions.push({
        dispose() {
            if (flashTimer) clearTimeout(flashTimer);
            if (flashDecoration) flashDecoration.dispose();
        },
    });
}

function deactivate() {
    if (flashTimer) clearTimeout(flashTimer);
    if (flashDecoration) flashDecoration.dispose();
}

module.exports = { activate, deactivate };
