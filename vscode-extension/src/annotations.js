// Annotations: durable, labelled marks the agent leaves on the code it is
// explaining.
//
// The point is that an explanation in the terminal and the code in the editor
// stop being two separate things. The agent says "this is where the launch
// fails" and the line itself carries a gutter icon and a hover with the reason.
//
// Unlike /reveal's flash, annotations persist until they are cleared or
// replaced. VS Code drops decorations when an editor is closed, so the state
// lives here and is re-applied whenever the file becomes visible again.

const vscode = require("vscode");

const { diag } = require("./log");
const { clampRange } = require("./reveal");
const diagnostics = require("./diagnostics");

const SEVERITIES = ["info", "warn", "error", "note"];

const SEVERITY_STYLE = {
    info: { color: "editorInfo.foreground", ruler: "editorOverviewRuler.infoForeground" },
    warn: { color: "editorWarning.foreground", ruler: "editorOverviewRuler.warningForeground" },
    error: { color: "editorError.foreground", ruler: "editorOverviewRuler.errorForeground" },
    note: { color: "editor.findMatchBorder", ruler: "editorOverviewRuler.findMatchForeground" },
};

/** file (fsPath, lower-cased on Windows) -> annotation records, in payload order. */
const byFile = new Map();
/** Flat, payload-ordered list backing next/previous/list. */
let ordered = [];
let title = null;

let decorationTypes = null;
let statusBar = null;
let extensionUri = null;
let cursor = -1;

function key(fsPath) {
    return process.platform === "win32" ? fsPath.toLowerCase() : fsPath;
}

function settings() {
    const cfg = vscode.workspace.getConfiguration("porthole");
    return {
        gutterIcons: cfg.get("annotations.gutterIcons", true),
        autoRevealFocus: cfg.get("annotations.autoRevealFocus", true),
    };
}

function buildDecorationTypes() {
    disposeDecorationTypes();
    const { gutterIcons } = settings();

    decorationTypes = {};
    for (const severity of SEVERITIES) {
        const style = SEVERITY_STYLE[severity];
        const options = {
            borderWidth: "0 0 2px 0",
            borderStyle: "solid",
            borderColor: new vscode.ThemeColor(style.color),
            overviewRulerColor: new vscode.ThemeColor(style.ruler),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        };
        if (gutterIcons && extensionUri) {
            options.gutterIconPath = vscode.Uri.joinPath(
                extensionUri,
                "media",
                `annotation-${severity}.svg`,
            );
            options.gutterIconSize = "contain";
        }
        decorationTypes[severity] = vscode.window.createTextEditorDecorationType(options);
    }
}

function disposeDecorationTypes() {
    if (!decorationTypes) return;
    for (const type of Object.values(decorationTypes)) type.dispose();
    decorationTypes = null;
}

function normalise(entry, index) {
    const severity = SEVERITIES.includes(entry.severity) ? entry.severity : "info";
    const startLine = toInt(entry.startLine, 1);
    const endLine = toInt(entry.endLine, startLine);
    return {
        index,
        file: entry.file,
        startLine,
        endLine,
        startCol: entry.startCol === undefined ? null : toInt(entry.startCol, 1),
        endCol: entry.endCol === undefined || entry.endCol === null ? null : toInt(entry.endCol, 1),
        severity,
        message: typeof entry.message === "string" ? entry.message : "",
    };
}

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function hover(entry) {
    const where = `${entry.startLine}${entry.endLine !== entry.startLine ? `-${entry.endLine}` : ""}`;
    const md = new vscode.MarkdownString();
    // Never trusted: the text comes from a model, and a trusted MarkdownString
    // can embed command links.
    md.isTrusted = false;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**porthole** · ${entry.severity} · line ${where}\n\n`);
    if (entry.message) md.appendMarkdown(entry.message);
    return md;
}

/** Re-applies the stored annotations to one editor. */
function applyTo(editor) {
    if (!decorationTypes || !editor) return;
    const entries = byFile.get(key(editor.document.uri.fsPath)) || [];

    for (const severity of SEVERITIES) {
        const options = entries
            .filter((e) => e.severity === severity)
            .map((e) => ({
                range: clampRange(
                    editor.document,
                    e.startLine,
                    e.endLine,
                    e.startCol || 1,
                    e.endCol === null ? undefined : e.endCol,
                ),
                hoverMessage: hover(e),
            }));
        editor.setDecorations(decorationTypes[severity], options);
    }
}

function applyToAllVisible() {
    for (const editor of vscode.window.visibleTextEditors) applyTo(editor);
}

function updateStatusBar() {
    if (!statusBar) return;
    if (ordered.length === 0) {
        statusBar.hide();
        return;
    }
    statusBar.text = `$(bookmark) porthole: ${ordered.length}`;
    statusBar.tooltip = title
        ? `${title}\n\nClick to jump between porthole annotations.`
        : "Click to jump between porthole annotations.";
    statusBar.show();
}

/**
 * Applies an annotation payload.
 *
 * `clearExisting` defaults to true so a new explanation replaces the previous
 * one; passing false lets a caller build a set up across several calls.
 */
async function annotate(payload) {
    const incoming = Array.isArray(payload.annotations) ? payload.annotations : [];
    const clearExisting = payload.clearExisting !== false;

    if (clearExisting) {
        clearState();
        title = payload.title || null;
    } else if (payload.title) {
        title = payload.title;
    }

    const accepted = [];
    const rejected = [];

    for (const raw of incoming) {
        if (!raw || !raw.file) {
            rejected.push("entry without a 'file'");
            continue;
        }
        const entry = normalise(raw, ordered.length + accepted.length);
        accepted.push(entry);
    }

    for (const entry of accepted) {
        const k = key(entry.file);
        if (!byFile.has(k)) byFile.set(k, []);
        byFile.get(k).push(entry);
        ordered.push(entry);
    }

    // Opening the focused file makes the annotation visible immediately;
    // everything else lights up as the user navigates to it.
    const { autoRevealFocus } = settings();
    let focused = null;
    if (autoRevealFocus && accepted.length > 0) {
        const index = toInt(payload.focus, 0);
        focused = accepted[index] || accepted[0];
        await revealEntry(focused);
        cursor = ordered.indexOf(focused);
    }

    applyToAllVisible();
    updateStatusBar();
    diagnostics.publish("annotations", ordered);

    diag(`annotate ${accepted.length} accepted, ${rejected.length} rejected`);

    return {
        ok: accepted.length > 0 || incoming.length === 0,
        applied: accepted.length,
        total: ordered.length,
        files: byFile.size,
        rejected: rejected.length ? rejected : undefined,
        error: accepted.length === 0 && incoming.length > 0 ? rejected.join("; ") : undefined,
    };
}

async function revealEntry(entry) {
    let document;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
    } catch (err) {
        diag(`reveal annotation failed: ${err.message}`);
        return false;
    }
    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
    });
    const range = clampRange(
        document,
        entry.startLine,
        entry.endLine,
        entry.startCol || 1,
        entry.endCol === null ? undefined : entry.endCol,
    );
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    applyTo(editor);
    return true;
}

/** The current set, for saving a review. */
function getState() {
    return { title, entries: ordered, current: cursor };
}

function clearState() {
    byFile.clear();
    ordered = [];
    cursor = -1;
    title = null;
}

function clear() {
    if (decorationTypes) {
        for (const editor of vscode.window.visibleTextEditors) {
            for (const severity of SEVERITIES) {
                editor.setDecorations(decorationTypes[severity], []);
            }
        }
    }
    clearState();
    updateStatusBar();
    diagnostics.clear("annotations");
    return { ok: true, total: 0 };
}

async function step(delta) {
    if (ordered.length === 0) {
        vscode.window.showInformationMessage("porthole: no annotations.");
        return;
    }
    cursor = (cursor + delta + ordered.length) % ordered.length;
    await revealEntry(ordered[cursor]);
}

async function list() {
    if (ordered.length === 0) {
        vscode.window.showInformationMessage("porthole: no annotations.");
        return;
    }
    const items = ordered.map((entry, i) => ({
        label: `$(${iconFor(entry.severity)}) ${shortName(entry.file)}:${entry.startLine}`,
        description: entry.endLine !== entry.startLine ? `-${entry.endLine}` : "",
        detail: firstLine(entry.message),
        index: i,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: title || "porthole annotations",
        placeHolder: "Jump to an annotation",
        matchOnDetail: true,
    });
    if (!picked) return;
    cursor = picked.index;
    await revealEntry(ordered[cursor]);
}

function iconFor(severity) {
    if (severity === "error") return "error";
    if (severity === "warn") return "warning";
    if (severity === "note") return "bookmark";
    return "info";
}

function shortName(file) {
    return String(file).split(/[\\/]/).pop();
}

function firstLine(message) {
    const line = String(message || "").split(/\r?\n/)[0].replace(/[*_`#]/g, "");
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function activate(context) {
    extensionUri = context.extensionUri;
    buildDecorationTypes();

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = "porthole.listAnnotations";
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        // Decorations are per-editor and are lost when an editor closes, so the
        // stored state is the source of truth and gets re-applied here.
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) applyTo(editor);
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("porthole.annotations.gutterIcons")) {
                buildDecorationTypes();
                applyToAllVisible();
            }
        }),
        vscode.commands.registerCommand("porthole.clearAnnotations", clear),
        vscode.commands.registerCommand("porthole.nextAnnotation", () => step(1)),
        vscode.commands.registerCommand("porthole.previousAnnotation", () => step(-1)),
        vscode.commands.registerCommand("porthole.listAnnotations", list),
        { dispose: disposeDecorationTypes },
    );
}

module.exports = { activate, annotate, clear, applyToAllVisible, getState };
