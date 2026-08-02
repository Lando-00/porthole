// Reveal: open a file and select a range.
//
// This is the one thing the VS Code CLI genuinely cannot do. `code --goto
// file:line:col` places a cursor; selecting a *range* needs an extension
// running inside the window.

const vscode = require("vscode");

const { diag } = require("./log");

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

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Opens `file` and selects the given range.
 *
 * Returns a result object rather than throwing, because the caller turns it
 * straight into an ack for the CLI.
 */
async function reveal(params) {
    const filePath = params.file;
    if (!filePath) {
        return { ok: false, error: "missing the 'file' parameter" };
    }

    const startLine = toInt(params.start, 1);
    const endLine = toInt(params.end, startLine);
    const startCol = toInt(params.startCol, 1);
    const endCol =
        params.endCol === undefined || params.endCol === null ? undefined : toInt(params.endCol, 1);

    let document;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch (err) {
        return { ok: false, error: `could not open ${filePath}: ${err.message}` };
    }

    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
    });

    const range = clampRange(document, startLine, endLine, startCol, endCol);
    diag(`reveal ${filePath} lines ${range.start.line + 1}-${range.end.line + 1}`);

    const { style, flashDurationMs } = getConfig();

    editor.selection =
        style === "selection" || style === "both"
            ? new vscode.Selection(range.start, range.end)
            : new vscode.Selection(range.start, range.start);

    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    if (style === "flash" || style === "both") {
        const decoration = ensureFlashDecoration();
        if (params.preserve !== "1" && params.preserve !== true && flashTimer) {
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

    return {
        ok: true,
        file: filePath,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        style,
    };
}

/**
 * Clamps a 1-based line range to the document.
 *
 * A range past the end of the file is silently dropped by VS Code, which looks
 * exactly like the command doing nothing.
 */
function clampRange(document, startLine, endLine, startCol, endCol) {
    const lastLine = Math.max(0, document.lineCount - 1);
    const s = Math.min(Math.max(startLine - 1, 0), lastLine);
    const e = Math.min(Math.max(endLine - 1, 0), lastLine);
    const from = Math.min(s, e);
    const to = Math.max(s, e);

    const startCharacter = Math.max((startCol || 1) - 1, 0);
    const endCharacter =
        endCol !== undefined ? Math.max(endCol - 1, 0) : document.lineAt(to).text.length;

    return new vscode.Range(from, startCharacter, to, endCharacter);
}

function dispose() {
    if (flashTimer) clearTimeout(flashTimer);
    if (flashDecoration) flashDecoration.dispose();
    flashTimer = null;
    flashDecoration = null;
}

module.exports = { reveal, clearHighlight, clampRange, dispose };
