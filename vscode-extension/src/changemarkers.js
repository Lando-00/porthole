// Change markers: which lines the active Tour's Recorded comparison touched.
//
// Always the comparison's base against the saved file - one rule, honest in
// every case, and the same right-hand side as the Step diff. Hidden while a
// file has unsaved edits, because the markers describe what is on disk.
//
// Thin whole-line borders and overview-ruler marks rather than gutter icons:
// the gutter already belongs to breakpoints, source control and Tour steps.

const MAX_EDITORS = 10;
const DEBOUNCE_MS = 150;

function samePath(left, right) {
    return process.platform === "win32"
        ? String(left).toLowerCase() === String(right).toLowerCase()
        : left === right;
}

/**
 * @param deps.vscode   the vscode API (or a fake)
 * @param deps.tour     { getLibrary, activeComparison, tourComparison }
 * @param deps.history  { changedRanges, toRepoRelative }
 */
function createChangeMarkers(deps) {
    const { vscode, tour, history } = deps;
    const schedule = deps.setTimeout || setTimeout;
    const cancel = deps.clearTimeout || clearTimeout;

    let toggledOn = true;
    let timer = null;
    let generation = 0;
    const cache = new Map();
    const decorated = new Set();

    const border = (color) => ({
        isWholeLine: true,
        borderWidth: "0 0 0 3px",
        borderStyle: "solid",
        borderColor: new vscode.ThemeColor(color),
    });
    const types = {
        added: vscode.window.createTextEditorDecorationType({
            ...border("editorGutter.addedBackground"),
            overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
        modified: vscode.window.createTextEditorDecorationType({
            ...border("editorGutter.modifiedBackground"),
            overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
        deleted: vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderWidth: "2px 0 0 0",
            borderStyle: "solid",
            borderColor: new vscode.ThemeColor("editorGutter.deletedBackground"),
            overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
    };

    function enabled() {
        const setting = vscode.workspace.getConfiguration("porthole").get("tour.changeMarkers", true);
        return setting !== false && toggledOn;
    }

    function clear(editor) {
        for (const type of Object.values(types)) editor.setDecorations(type, []);
    }

    function clearAll() {
        for (const editor of vscode.window.visibleTextEditors) {
            if (decorated.has(editor)) clear(editor);
        }
        decorated.clear();
    }

    function removedHover(count) {
        const hover = new vscode.MarkdownString(
            `${count} line${count === 1 ? "" : "s"} removed here by the Recorded comparison — ` +
                "[Open Step diff](command:porthole.tour.diff)",
        );
        hover.isTrusted = { enabledCommands: ["porthole.tour.diff"] };
        return hover;
    }

    function decorationsFor(hunks, lineCount) {
        const clamp = (line) => Math.max(0, Math.min(Math.max(lineCount - 1, 0), line - 1));
        const out = { added: [], modified: [], deleted: [] };
        for (const hunk of hunks) {
            if (hunk.kind === "deleted") {
                const line = clamp(hunk.start);
                out.deleted.push({
                    range: new vscode.Range(line, 0, line, 0),
                    hoverMessage: removedHover(hunk.removedLines || 1),
                });
            } else if (out[hunk.kind]) {
                out[hunk.kind].push({ range: new vscode.Range(clamp(hunk.start), 0, clamp(hunk.end), 0) });
            }
        }
        return out;
    }

    async function hunksFor(details, rel, oldRel, document) {
        const key = `${details.publicationId}|${document.uri.fsPath}|${document.version}`;
        if (!cache.has(key)) {
            const { kind, base, target } = details.comparison;
            cache.set(key, history.changedRanges(details.repo, { kind, base, target }, rel, oldRel));
            if (cache.size > 200) cache.delete(cache.keys().next().value);
        }
        return cache.get(key);
    }

    async function refresh() {
        const mine = ++generation;
        const current = tour.activeComparison();
        if (!current || !enabled()) {
            clearAll();
            return;
        }
        const details = tour.tourComparison(current.tourId);
        if (!details) {
            clearAll();
            return;
        }
        const editors = vscode.window.visibleTextEditors
            .filter((editor) => editor.document.uri.scheme === "file")
            .slice(0, MAX_EDITORS);
        const stillDecorated = new Set();
        for (const editor of editors) {
            const { document } = editor;
            const onTour = details.steps.some((step) => step && samePath(step.file, document.uri.fsPath));
            if (!onTour || document.isDirty) {
                if (decorated.has(editor)) clear(editor);
                continue;
            }
            const rel = history.toRepoRelative(details.repo, document.uri.fsPath);
            if (!rel) continue;
            const oldRel = details.comparison.renames?.[rel] || rel;
            const ranges = await hunksFor(details, rel, oldRel, document);
            if (mine !== generation) return;
            if (!ranges.ok || document.isDirty) {
                clear(editor);
                continue;
            }
            const sets = decorationsFor(ranges.hunks, document.lineCount);
            for (const [kind, type] of Object.entries(types)) editor.setDecorations(type, sets[kind]);
            stillDecorated.add(editor);
        }
        for (const editor of decorated) {
            if (!stillDecorated.has(editor) && editors.includes(editor)) clear(editor);
        }
        decorated.clear();
        for (const editor of stillDecorated) decorated.add(editor);
    }

    function request() {
        if (timer) cancel(timer);
        timer = schedule(() => {
            timer = null;
            void refresh();
        }, DEBOUNCE_MS);
    }

    function toggle() {
        toggledOn = !toggledOn;
        request();
        return toggledOn;
    }

    function dispose() {
        if (timer) cancel(timer);
        clearAll();
        for (const type of Object.values(types)) type.dispose();
    }

    return { refresh, request, toggle, dispose, decorationsFor, isOn: () => toggledOn };
}

function activate(context) {
    const vscode = require("vscode");
    const tour = require("./tour");
    const history = require("./history");
    const markers = createChangeMarkers({ vscode, tour, history });

    context.subscriptions.push(
        { dispose: markers.dispose },
        vscode.commands.registerCommand("porthole.tour.toggleChangeMarkers", () => {
            const on = markers.toggle();
            void vscode.window.showInformationMessage(
                `porthole: change markers ${on ? "shown" : "hidden"} in this window.`,
            );
        }),
        tour.onDidChangeState(() => markers.request()),
        vscode.window.onDidChangeVisibleTextEditors(() => markers.request()),
        vscode.workspace.onDidSaveTextDocument(() => markers.request()),
        vscode.workspace.onDidChangeTextDocument((event) => {
            // Only the clean -> dirty edge matters: markers hide until the save.
            if (event.document.isDirty && event.contentChanges.length) markers.request();
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("porthole.tour.changeMarkers")) markers.request();
        }),
    );
    markers.request();
}

module.exports = { createChangeMarkers, activate };
