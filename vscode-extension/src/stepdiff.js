// Step diff: what the Recorded comparison did to the file under a Tour step.
//
// Opens VS Code's own diff editor beside the source, so the Walkthrough stays
// where it is. The right-hand side is the saved file by default: its line
// numbers are the step's, and it is what the user is actually reading. The
// recorded target revision is one click away when the two differ.
//
// Nothing here moves the Tour, fetches, or checks anything out. A commit the
// clone does not have is reported, not obtained.

const fs = require("node:fs");

const MESSAGE_LIMIT = 300;

function short(oid) {
    return oid ? String(oid).slice(0, 7) : "the empty tree";
}

function failure(error, reason = "step-diff") {
    return { ok: false, reason, error };
}

function samePath(left, right) {
    return process.platform === "win32"
        ? String(left).toLowerCase() === String(right).toLowerCase()
        : left === right;
}

/**
 * @param deps.vscode      the vscode API (or a fake)
 * @param deps.tour        { getLibrary, tourComparison }
 * @param deps.history     { hasCommit, savedMatchesTarget, changedRanges, toRepoRelative }
 * @param deps.revisionUri (vscode, { repo, oid, path }) => Uri
 * @param deps.exists      optional file-existence check
 */
function createStepDiff(deps) {
    const { vscode, tour, history, revisionUri } = deps;
    const exists = deps.exists || ((file) => fs.existsSync(file));

    function locate(tourId, index) {
        const library = tour.getLibrary();
        const id = tourId || library.activeTourId;
        if (!id) return failure("No Tour is active; start one or name a Tour.", "no-active-tour");
        const entry = library.tours.find((candidate) => candidate.tourId === id);
        if (!entry) return failure(`Tour '${id}' is not loaded in this window; activate it first.`, "not-loaded");
        const details = tour.tourComparison(id);
        if (!details) return failure(`Tour '${id}' has no Recorded comparison, so there is no Step diff.`, "no-comparison");
        const current = entry.tourId === library.activeTourId && entry.current >= 0 ? entry.current : 0;
        const at = Number.isInteger(index) ? index : current;
        const step = details.steps[at];
        if (!step) return failure(`Tour '${id}' has no step ${at + 1}.`, "invalid-step");
        if (!details.repo) return failure(`Tour '${id}' has no repository to compare in.`, "no-repository");
        const rel = history.toRepoRelative(details.repo, step.file);
        if (!rel) return failure(`Step ${at + 1}'s file is outside the Tour's repository.`, "outside-repository");
        return { ok: true, id, at, step, rel, ...details };
    }

    function rangeIntersects(hunks, step) {
        const end = step.endLine || step.startLine;
        return hunks.some((hunk) => hunk.start <= end && hunk.end >= step.startLine);
    }

    async function open({ tourId, index, side = "saved", interactive = false } = {}) {
        const found = locate(tourId, index);
        if (!found.ok) return found;
        const { id, at, step, rel, repo, comparison } = found;
        const label = String(comparison.label || "Recorded comparison").slice(0, MESSAGE_LIMIT);
        const oldRel = (comparison.renames && comparison.renames[rel]) || rel;
        const notes = [];
        if (comparison.renamesComplete === false && oldRel === rel) {
            notes.push("Rename history was unavailable when this comparison was recorded; a renamed file may show as added.");
        }

        for (const oid of [comparison.base, comparison.target]) {
            if (oid && !(await history.hasCommit(repo, oid))) {
                return failure(
                    `Commit ${short(oid)} isn't available in this clone; fetch it to see the Step diff.`,
                    "missing-object",
                );
            }
        }

        const baseHasFile = comparison.base
            ? await history.hasPath(repo, comparison.base, oldRel)
            : false;
        const left = baseHasFile
            ? revisionUri(vscode, { repo, oid: comparison.base, path: oldRel })
            : revisionUri(vscode, { repo, oid: "empty", path: rel });

        const wantsTarget = side === "target" && comparison.kind === "revisions" && comparison.target;
        let right;
        let suffix;
        let savedDiffersFromTarget = false;
        let noChangesInRange = false;

        if (wantsTarget) {
            right = revisionUri(vscode, { repo, oid: comparison.target, path: rel });
            suffix = `${label} (recorded revisions)`;
        } else if (!exists(step.file)) {
            right = revisionUri(vscode, { repo, oid: "empty", path: rel });
            suffix = `${label} · file no longer exists`;
        } else {
            right = vscode.Uri.file(step.file);
            if (comparison.kind === "live") {
                suffix = `Live working changes since ${short(comparison.base)}`;
            } else {
                const same = await history.savedMatchesTarget(repo, comparison.target, rel, step.file);
                savedDiffersFromTarget = same === false;
                suffix = same === true
                    ? label
                    : same === false
                      ? `${label} · current file differs from ${short(comparison.target)}`
                      : `${label} · could not compare with ${short(comparison.target)}`;
            }
            const dirty = vscode.workspace.textDocuments.some(
                (document) => document.isDirty && samePath(document.uri.fsPath, step.file),
            );
            if (dirty) suffix += " (unsaved edits shown)";

            const ranges = await history.changedRanges(
                repo,
                { kind: comparison.kind, base: comparison.base, target: comparison.target },
                rel,
                oldRel,
            );
            if (ranges.ok && !rangeIntersects(ranges.hunks, step)) noChangesInRange = true;
        }

        const title = `${rel.split("/").pop()} — ${suffix}`;
        const first = Math.max(0, step.startLine - 1);
        const last = Math.max(first, (step.endLine || step.startLine) - 1);
        // Ranges are end-exclusive: end at the start of the next line so the
        // step's last line is selected too. The editor clamps it at end of file.
        await vscode.commands.executeCommand("vscode.diff", left, right, title, {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside,
            selection: new vscode.Range(first, 0, last + 1, 0),
        });

        if (savedDiffersFromTarget) {
            const button = `Compare with ${short(comparison.target)}`;
            void Promise.resolve(vscode.window.showInformationMessage(
                `porthole: the saved file differs from ${short(comparison.target)}, the comparison's recorded target.`,
                button,
            )).then((choice) => {
                if (choice === button) void open({ tourId: id, index: at, side: "target", interactive });
            });
        } else if (noChangesInRange) {
            void vscode.window.showInformationMessage("porthole: no changes in this step's range.");
        }
        for (const note of notes) void vscode.window.showWarningMessage(`porthole: ${note}`);

        return {
            ok: true,
            result: {
                tourId: id,
                step: at,
                side: wantsTarget ? "target" : "saved",
                title,
                savedDiffersFromTarget,
                noChangesInRange,
                notes,
            },
        };
    }

    return { open };
}

function stepArgument(arg) {
    if (arg && typeof arg === "object" && arg.portholeStep) return arg.portholeStep;
    return {};
}

function activate(context) {
    const vscode = require("vscode");
    const tour = require("./tour");
    const history = require("./history");
    const { revisionUri } = require("./revcontent");
    const stepDiff = createStepDiff({ vscode, tour, history, revisionUri });

    const run = async (arg, side) => {
        const { tourId, index } = stepArgument(arg);
        const result = await stepDiff.open({ tourId, index, side, interactive: true });
        if (!result.ok) void vscode.window.showWarningMessage(`porthole: ${result.error}`);
    };

    const updateContext = () => {
        const library = tour.getLibrary();
        const entry = library.tours.find((candidate) => candidate.tourId === library.activeTourId);
        void vscode.commands.executeCommand(
            "setContext",
            "porthole.tourHasComparison",
            Boolean(entry?.publication?.comparison),
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.tour.diff", (arg) => run(arg, "saved")),
        vscode.commands.registerCommand("porthole.tour.diffRecorded", (arg) => run(arg, "target")),
        tour.onDidChangeState(updateContext),
    );
    updateContext();
    module.exports.route = (payload = {}) => stepDiff.open({
        tourId: typeof payload.tourId === "string" && payload.tourId ? payload.tourId : undefined,
        index: Number.isInteger(payload.step) ? payload.step : undefined,
        side: payload.side === "target" ? "target" : "saved",
    });
}

async function route() {
    return failure("the Step diff is not ready in this window yet");
}

module.exports = { createStepDiff, activate, route };
