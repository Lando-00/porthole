// Walkthrough mode.
//
// An annotation set answers "look at these places". A tour answers "follow this
// path, in this order, and here is why each step matters" - which is what an
// explanation actually is.
//
// Four surfaces, because a walkthrough has to be discoverable without reading
// the docs:
//
//   CodeLens   inline above the step, with the narration and Next/Prev/Exit
//   gutter     a marker per step showing done / here / still to come
//   status bar "Step 3/9", click to advance
//   sidebar    the whole path at a glance, click any step to jump
//
// The state lives here and the surfaces read from it, so they can never
// disagree about which step is current.

const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { diag } = require("./log");
const { clampRange } = require("./reveal");
const diagnostics = require("./diagnostics");

const MAX_STEPS = 50;
const MAX_NARRATION = 2000;
const LENS_TITLE_MAX = 90;

let steps = [];
let current = -1;
let title = null;

let statusBar = null;
let decorations = null;
let extensionUri = null;

const lensChanged = new vscode.EventEmitter();
const stateChanged = new vscode.EventEmitter();

/** Fires when the step list or the cursor moves, for the tree view. */
const onDidChangeState = stateChanged.event;

// --- state ------------------------------------------------------------------

function isActive() {
    return steps.length > 0;
}

function getState() {
    return { title, steps, current };
}

/**
 * Announces a state change once, to every surface.
 *
 * CodeLenses are deliberately refreshed from here and nowhere else. Firing on
 * document changes as well would re-render the lenses on every keystroke, which
 * reads as flicker.
 */
function changed() {
    lensChanged.fire();
    stateChanged.fire(getState());
    updateStatusBar();
    applyToAllVisible();
    void vscode.commands.executeCommand("setContext", "porthole.tourActive", isActive());
}

function normalise(raw, index) {
    const startLine = toInt(raw.startLine, 1);
    const endLine = Math.max(startLine, toInt(raw.endLine, startLine));
    return {
        index,
        file: raw.file,
        startLine,
        endLine,
        stepTitle: text(raw.stepTitle, 200) || `Step ${index + 1}`,
        narration: text(raw.narration, MAX_NARRATION),
        severity: ["info", "warn", "error", "note"].includes(raw.severity) ? raw.severity : "info",
    };
}

function text(value, max) {
    const s = typeof value === "string" ? value.trim() : "";
    return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolves a step's file, allowing paths relative to a workspace folder.
 *
 * Existence is checked for absolute paths too. Taking them on trust meant a
 * tour could be accepted with steps pointing at files that were never there,
 * and only fall over later with a popup per step - the caller having already
 * been told everything was fine.
 */
function resolveFile(file) {
    if (!file) return null;

    if (path.isAbsolute(file)) return exists(file) ? file : null;

    for (const folder of vscode.workspace.workspaceFolders || []) {
        const candidate = path.join(folder.uri.fsPath, file);
        if (exists(candidate)) return candidate;
    }
    return null;
}

function exists(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

// --- the route --------------------------------------------------------------

/** Starts a tour. Replaces any tour already running. */
async function start(payload = {}) {
    const incoming = Array.isArray(payload.steps) ? payload.steps : [];
    if (incoming.length === 0) return { ok: false, error: "a tour needs at least one step" };
    if (incoming.length > MAX_STEPS) {
        return { ok: false, error: `a tour is limited to ${MAX_STEPS} steps` };
    }

    const accepted = [];
    const skipped = [];

    for (const [i, raw] of incoming.entries()) {
        if (!raw || !raw.file) {
            skipped.push({ index: i, reason: "step has no 'file'" });
            continue;
        }
        const file = resolveFile(raw.file);
        if (!file) {
            // Reported rather than dropped: a tour that quietly loses a step is
            // an explanation with a hole in it.
            skipped.push({ index: i, reason: `file not found: ${raw.file}` });
            continue;
        }
        accepted.push(normalise({ ...raw, file }, accepted.length));
    }

    if (accepted.length === 0) {
        return { ok: false, error: "no step could be resolved", result: { steps: 0, skipped } };
    }

    steps = accepted;
    title = text(payload.title, 200) || null;
    current = -1;

    diagnostics.publish(
        "tour",
        steps.map((s) => ({ ...s, message: s.stepTitle })),
    );

    if (payload.start !== false) await goto(0);
    else changed();

    diag(`tour started: ${accepted.length} steps, ${skipped.length} skipped`);
    return { ok: true, result: { steps: accepted.length, skipped } };
}

// --- navigation -------------------------------------------------------------

async function goto(index) {
    if (!isActive()) {
        vscode.window.showInformationMessage("porthole: no tour is running.");
        return false;
    }
    if (index < 0 || index >= steps.length) return false;

    current = index;
    changed();
    return revealStep(steps[index]);
}

async function step(delta) {
    if (!isActive()) {
        vscode.window.showInformationMessage("porthole: no tour is running.");
        return;
    }
    // Wraps, so stepping past the end returns to the start rather than
    // dead-ending on the last step.
    await goto((current + delta + steps.length) % steps.length);
}

async function revealStep(entry) {
    let document;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
    } catch (err) {
        diag(`tour reveal failed: ${err.message}`);
        vscode.window.showWarningMessage(`porthole: could not open ${entry.file}`);
        return false;
    }

    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
    });
    const range = clampRange(document, entry.startLine, entry.endLine, 1, undefined);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    applyTo(editor);
    return true;
}

function exit() {
    steps = [];
    current = -1;
    title = null;
    diagnostics.clear("tour");
    clearDecorations();
    changed();
    return { ok: true };
}

async function list() {
    if (!isActive()) {
        vscode.window.showInformationMessage("porthole: no tour is running.");
        return;
    }
    const picked = await vscode.window.showQuickPick(
        steps.map((s) => ({
            label: `${s.index === current ? "$(play)" : "$(circle-outline)"} ${s.index + 1}. ${s.stepTitle}`,
            description: `${shortName(s.file)}:${s.startLine}`,
            detail: firstLine(s.narration),
            index: s.index,
        })),
        { title: title || "porthole tour", placeHolder: "Jump to a step", matchOnDetail: true },
    );
    if (picked) await goto(picked.index);
}

// --- gutter -----------------------------------------------------------------

function buildDecorations() {
    clearDecorations();
    const icon = (name) => vscode.Uri.joinPath(extensionUri, "media", name);
    decorations = {
        current: vscode.window.createTextEditorDecorationType({
            gutterIconPath: icon("tour-current.svg"),
            gutterIconSize: "contain",
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
        }),
        visited: vscode.window.createTextEditorDecorationType({
            gutterIconPath: icon("tour-visited.svg"),
            gutterIconSize: "contain",
        }),
        pending: vscode.window.createTextEditorDecorationType({
            gutterIconPath: icon("tour-pending.svg"),
            gutterIconSize: "contain",
        }),
    };
}

function clearDecorations() {
    if (!decorations) return;
    for (const type of Object.values(decorations)) type.dispose();
    decorations = null;
}

function applyTo(editor) {
    if (!editor) return;
    if (!decorations) buildDecorations();

    const mine = steps.filter((s) => samePath(s.file, editor.document.uri.fsPath));
    const buckets = { current: [], visited: [], pending: [] };

    for (const s of mine) {
        const bucket = s.index === current ? "current" : s.index < current ? "visited" : "pending";
        buckets[bucket].push({
            range: clampRange(editor.document, s.startLine, s.endLine, 1, undefined),
            hoverMessage: hover(s),
        });
    }

    for (const [name, options] of Object.entries(buckets)) {
        editor.setDecorations(decorations[name], options);
    }
}

function applyToAllVisible() {
    for (const editor of vscode.window.visibleTextEditors) applyTo(editor);
}

function samePath(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase();
}

function hover(s) {
    const md = new vscode.MarkdownString();
    // Never trusted: the narration is model-written, and a trusted
    // MarkdownString can embed command links.
    md.isTrusted = false;
    md.appendMarkdown(`**Step ${s.index + 1}/${steps.length}** · ${s.stepTitle}\n\n`);
    if (s.narration) md.appendMarkdown(s.narration);
    return md;
}

// --- code lens --------------------------------------------------------------

/**
 * The lens is the whole point of the feature: the narration sits directly above
 * the code it describes, with the controls right there, so stepping through
 * never requires looking away.
 */
const lensProvider = {
    onDidChangeCodeLenses: lensChanged.event,

    provideCodeLenses(document) {
        if (!isActive()) return [];
        const mine = steps.filter((s) => samePath(s.file, document.uri.fsPath));
        const lenses = [];

        for (const s of mine) {
            const line = Math.max(0, Math.min(document.lineCount - 1, s.startLine - 1));
            const range = new vscode.Range(line, 0, line, 0);
            const position = `${s.index + 1}/${steps.length}`;

            if (s.index !== current) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(circle-outline) Step ${position} — ${s.stepTitle}`,
                        command: "porthole.tour.goto",
                        arguments: [s.index],
                    }),
                );
                continue;
            }

            lenses.push(
                new vscode.CodeLens(range, {
                    title: `$(play) Step ${position} — ${lensText(s)}`,
                    command: "porthole.tour.list",
                }),
                new vscode.CodeLens(range, {
                    title: "$(arrow-right) Next",
                    command: "porthole.tour.next",
                }),
                new vscode.CodeLens(range, {
                    title: "$(arrow-left) Prev",
                    command: "porthole.tour.previous",
                }),
                new vscode.CodeLens(range, { title: "$(x) Exit", command: "porthole.tour.exit" }),
            );
        }
        return lenses;
    },
};

/** A lens is one line, so the narration is trimmed to its first sentence. */
function lensText(s) {
    const body = firstLine(s.narration);
    if (!body) return s.stepTitle;
    const combined = `${s.stepTitle}: ${body}`;
    return combined.length > LENS_TITLE_MAX
        ? `${combined.slice(0, LENS_TITLE_MAX - 3)}...`
        : combined;
}

function firstLine(value) {
    const line = String(value || "").split(/\r?\n/)[0].replace(/[*_`#]/g, "").trim();
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function shortName(file) {
    return String(file).split(/[\\/]/).pop();
}

// --- status bar -------------------------------------------------------------

function updateStatusBar() {
    if (!statusBar) return;
    if (!isActive()) {
        statusBar.hide();
        return;
    }
    const position = current >= 0 ? `${current + 1}/${steps.length}` : `${steps.length} steps`;
    statusBar.text = `$(play) porthole: Step ${position}`;
    statusBar.tooltip = `${title || "porthole tour"}\n\nClick for the next step.`;
    statusBar.show();
}

// --- lifecycle --------------------------------------------------------------

function activate(context) {
    extensionUri = context.extensionUri;
    buildDecorations();

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    statusBar.command = "porthole.tour.next";
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider),
        // Decorations are per-editor and lost when an editor closes, so the
        // stored state is the source of truth and is re-applied here.
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) applyTo(editor);
        }),
        vscode.commands.registerCommand("porthole.tour.next", () => step(1)),
        vscode.commands.registerCommand("porthole.tour.previous", () => step(-1)),
        vscode.commands.registerCommand("porthole.tour.goto", (index) => goto(index)),
        vscode.commands.registerCommand("porthole.tour.exit", exit),
        vscode.commands.registerCommand("porthole.tour.list", list),
        { dispose: clearDecorations },
    );

    void vscode.commands.executeCommand("setContext", "porthole.tourActive", false);
}

module.exports = { activate, start, exit, goto, step, getState, isActive, onDidChangeState };
