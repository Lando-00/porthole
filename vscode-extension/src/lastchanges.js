// Line last-changes: which commits last changed the selected lines.
//
// git blame, fed the live buffer through `--contents -`, so unsaved and
// uncommitted lines come back marked as such by git itself instead of being
// credited to whoever last committed nearby. "Last changed by", never
// "written by": blame reports the most recent change, not authorship.

const fs = require("node:fs");
const path = require("node:path");

const MAX_SEND_GROUPS = 20;

function short(oid) {
    return String(oid).slice(0, 7);
}

function relativeTime(ms, now = Date.now()) {
    if (!Number.isFinite(ms)) return "unknown date";
    const days = Math.floor((now - ms) / 86_400_000);
    if (days < 1) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
}

function lineRanges(lines) {
    const ranges = [];
    for (const line of lines) {
        const last = ranges.at(-1);
        if (last && line === last[1] + 1) last[1] = line;
        else ranges.push([line, line]);
    }
    return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}

function canonical(file) {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return path.resolve(file);
    }
}

/**
 * @param deps.vscode      the vscode API (or a fake)
 * @param deps.history     { lastChanges, toRepoRelative }
 * @param deps.runGit      bounded git runner
 * @param deps.revisionUri (vscode, { repo, oid, path }) => Uri
 */
function createLastChanges(deps) {
    const { vscode, history, runGit, revisionUri } = deps;

    async function repositoryFor(file) {
        const result = await runGit(["rev-parse", "--show-toplevel"], {
            cwd: path.dirname(file),
            timeoutMs: 3000,
            maxStdoutBytes: 64 * 1024,
        });
        return result.ok ? canonical(result.stdout.trim()) : null;
    }

    /** The grouped last changes for lines start..end (1-based) of a document. */
    async function collect(document, startLine, endLine) {
        const file = canonical(document.uri.fsPath);
        const repo = await repositoryFor(file);
        if (!repo) return { ok: false, error: "this file is not in a git repository" };
        const rel = history.toRepoRelative(repo, file);
        if (!rel) return { ok: false, error: "this file is outside its repository" };
        const result = await history.lastChanges(repo, rel, startLine, endLine, document.getText());
        if (!result.ok) {
            const reasons = {
                "too-many-lines": "select up to 2,000 lines",
                "too-large": "the file is too large to blame (over 4 MiB)",
                "not-repository": "this file is not in a git repository",
                timeout: "git blame did not finish in time",
            };
            return { ok: false, error: reasons[result.reason] || `git blame failed${result.detail ? `: ${result.detail}` : ""}` };
        }
        return { ok: true, repo, rel, unsaved: document.isDirty, groups: result.groups };
    }

    /** The shape sent to the CLI with a selection. */
    function summarise(collected) {
        return collected.groups.slice(0, MAX_SEND_GROUPS).map((group) => ({
            oid: group.uncommitted ? null : group.oid,
            author: group.uncommitted ? null : group.author,
            time: group.uncommitted ? null : group.time,
            summary: group.uncommitted ? null : String(group.summary || "").slice(0, 200),
            lines: group.finalLines,
            uncommitted: group.uncommitted,
            ...(group.uncommitted && collected.unsaved ? { unsaved: true } : {}),
        }));
    }

    async function compare(repo, group) {
        const after = revisionUri(vscode, { repo, oid: group.oid, path: group.filename });
        const before = group.previous
            ? revisionUri(vscode, { repo, oid: group.previous.oid, path: group.previous.path })
            : revisionUri(vscode, { repo, oid: "empty", path: group.filename });
        const line = Math.max(0, group.origStart - 1);
        await vscode.commands.executeCommand(
            "vscode.diff",
            before,
            after,
            `${path.posix.basename(group.filename)} — ${short(group.oid)} ${group.summary || ""}`.trim(),
            { preview: true, selection: new vscode.Range(line, 0, line, 0) },
        );
    }

    async function openCommit(repo, group) {
        const listed = await runGit(
            ["diff-tree", "--no-commit-id", "-r", "--root", "--name-status", "-z", "-M", "--no-ext-diff", group.oid],
            { cwd: repo, timeoutMs: 5000 },
        );
        if (!listed.ok) {
            void vscode.window.showWarningMessage(`porthole: could not list the files in ${short(group.oid)}.`);
            return;
        }
        const fields = listed.stdout.split("\0");
        const files = [];
        for (let i = 0; i < fields.length && fields[i];) {
            const status = fields[i++];
            const renamed = /^[RC]/.test(status);
            const oldPath = fields[i++];
            const newPath = renamed ? fields[i++] : oldPath;
            if (!oldPath || !newPath) break;
            files.push({ status: status[0], oldPath, newPath });
        }
        const parents = await runGit(["rev-list", "--parents", "-n", "1", group.oid], { cwd: repo, timeoutMs: 3000 });
        const parent = parents.ok ? parents.stdout.trim().split(/\s+/)[1] || null : group.previous?.oid || null;
        const sides = files.map((entry) => {
            const left = entry.status === "A" || !parent
                ? revisionUri(vscode, { repo, oid: "empty", path: entry.newPath })
                : revisionUri(vscode, { repo, oid: parent, path: entry.oldPath });
            const right = entry.status === "D"
                ? revisionUri(vscode, { repo, oid: "empty", path: entry.oldPath })
                : revisionUri(vscode, { repo, oid: group.oid, path: entry.newPath });
            return { entry, left, right };
        });
        const title = `${short(group.oid)} ${group.summary || ""}`.trim();
        const commands = await vscode.commands.getCommands(true);
        if (parent && commands.includes("vscode.changes")) {
            await vscode.commands.executeCommand(
                "vscode.changes",
                title,
                sides.map(({ entry, left, right }) => [vscode.Uri.file(path.join(repo, entry.newPath)), left, right]),
            );
            return;
        }
        const picked = await vscode.window.showQuickPick(
            sides.map((side) => ({ label: side.entry.newPath, description: side.entry.status, side })),
            { title, placeHolder: "Files changed by this commit" },
        );
        if (picked) {
            await vscode.commands.executeCommand(
                "vscode.diff",
                picked.side.left,
                picked.side.right,
                `${path.posix.basename(picked.side.entry.newPath)} — ${title}`,
                { preview: true },
            );
        }
    }

    async function show(document, startLine, endLine) {
        const collected = await collect(document, startLine, endLine);
        if (!collected.ok) {
            void vscode.window.showWarningMessage(`porthole: ${collected.error}.`);
            return;
        }
        const buttons = {
            compare: { iconPath: new vscode.ThemeIcon("diff"), tooltip: "Compare this change" },
            copy: { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Copy commit ID" },
            open: { iconPath: new vscode.ThemeIcon("git-commit"), tooltip: "Open commit" },
        };
        const items = collected.groups.map((group) => group.uncommitted
            ? {
                label: "$(circle-large-outline) Not committed yet",
                description: collected.unsaved ? "includes unsaved edits" : "uncommitted",
                detail: `${group.finalLines.length} line${group.finalLines.length === 1 ? "" : "s"}: ${lineRanges(group.finalLines)}`,
                group,
            }
            : {
                label: `$(git-commit) ${short(group.oid)}  ${group.summary || ""}`,
                description: `${group.author || "unknown"} · ${relativeTime(group.time)}`,
                detail: `${group.finalLines.length} line${group.finalLines.length === 1 ? "" : "s"}: ${lineRanges(group.finalLines)}`,
                buttons: [buttons.compare, buttons.copy, buttons.open],
                group,
            });

        const pick = vscode.window.createQuickPick();
        pick.title = `Last changes · ${collected.rel}:${startLine}–${endLine} · ${collected.unsaved ? "unsaved buffer" : "saved file"}`;
        pick.placeholder = "Last recorded changes, not original authorship";
        pick.items = items;
        pick.matchOnDescription = true;
        pick.onDidTriggerItemButton(async ({ item, button }) => {
            if (button === buttons.copy) {
                await vscode.env.clipboard.writeText(item.group.oid);
                void vscode.window.showInformationMessage(`porthole: copied ${short(item.group.oid)}.`);
            } else if (button === buttons.compare) {
                await compare(collected.repo, item.group);
            } else if (button === buttons.open) {
                await openCommit(collected.repo, item.group);
            }
        });
        pick.onDidAccept(async () => {
            const [item] = pick.selectedItems;
            if (item && !item.group.uncommitted) await compare(collected.repo, item.group);
        });
        pick.onDidHide(() => pick.dispose());
        pick.show();
    }

    return { collect, summarise, show, compare, openCommit };
}

let instance = null;

/** For send.js: the history attached to a selection, or null when unavailable. */
async function historyForSelection(document, startLine, endLine) {
    if (!instance) return { ok: false, error: "Line last-changes is not ready" };
    const collected = await instance.collect(document, startLine, endLine);
    return collected.ok ? { ok: true, history: instance.summarise(collected) } : collected;
}

function activate(context) {
    const vscode = require("vscode");
    const history = require("./history");
    const { runGit } = require("./gitrun");
    const { revisionUri } = require("./revcontent");
    const tour = require("./tour");
    instance = createLastChanges({ vscode, history, runGit, revisionUri });

    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.lineLastChanges", async (arg) => {
            if (arg && typeof arg === "object" && arg.portholeStep) {
                const { tourId, index } = arg.portholeStep;
                const step = tour.getTour(tourId)?.steps[index];
                if (!step) return;
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(step.file));
                const last = Math.min(document.lineCount, step.endLine || step.startLine);
                await instance.show(document, Math.min(step.startLine, last), last);
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== "file") {
                void vscode.window.showInformationMessage("porthole: open a file first.");
                return;
            }
            const { selection } = editor;
            const start = selection.start.line + 1;
            // A selection ending at column 0 does not include that line.
            const end = selection.isEmpty
                ? start
                : Math.max(start, selection.end.line + (selection.end.character === 0 ? 0 : 1));
            await instance.show(editor.document, start, end);
        }),
    );
}

module.exports = { createLastChanges, historyForSelection, activate, relativeTime, lineRanges };
