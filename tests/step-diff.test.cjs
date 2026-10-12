const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const history = require("../vscode-extension/src/history");
const { createStepDiff } = require("../vscode-extension/src/stepdiff");
const { createChangeMarkers } = require("../vscode-extension/src/changemarkers");
const { createLastChanges, lineRanges } = require("../vscode-extension/src/lastchanges");
const { runGit } = require("../vscode-extension/src/gitrun");

function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function repository() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "porthole-stepdiff-")));
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Porthole Tests"]);
    git(root, ["config", "user.email", "porthole@example.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "core.autocrlf", "false"]);
    return root;
}

function commit(root, message) {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "-m", message]);
    return git(root, ["rev-parse", "HEAD"]);
}

function lines(count, prefix = "line") {
    return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
        Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
    }
}

function fakeVscode({ dirty = [], commands = [] } = {}) {
    const executed = [];
    const messages = [];
    const decorations = [];
    return {
        executed,
        messages,
        decorations,
        Range,
        ViewColumn: { Beside: -2 },
        OverviewRulerLane: { Left: 1 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        MarkdownString: class { constructor(value) { this.value = value; } },
        Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
        workspace: {
            textDocuments: dirty.map((fsPath) => ({ isDirty: true, uri: { fsPath } })),
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        },
        window: {
            visibleTextEditors: [],
            showInformationMessage: async (...args) => { messages.push(["info", ...args]); return undefined; },
            showWarningMessage: async (...args) => { messages.push(["warn", ...args]); return undefined; },
            createTextEditorDecorationType: (options) => {
                const type = { options, dispose() {} };
                decorations.push(type);
                return type;
            },
        },
        commands: {
            executeCommand: async (...args) => { executed.push(args); },
            getCommands: async () => commands,
        },
    };
}

const revisionUri = (_vscode, side) => ({ scheme: "porthole-rev", ...side });

function fakeTour({ repo, comparison, steps, current = 0, active = true, publicationId = "pub-1" }) {
    const entry = { tourId: "t", current, steps, publication: { id: publicationId, repo, comparison } };
    let moved = 0;
    return {
        moved: () => moved,
        getLibrary: () => ({ tours: [entry], activeTourId: active ? "t" : null }),
        getTour: (id) => (id === "t" ? entry : null),
        goto: () => { moved += 1; },
        tourComparison: (id) => (id === "t" && comparison
            ? { tourId: "t", publicationId, repo, comparison, steps: steps.map(({ file, startLine, endLine }) => ({ file, startLine, endLine })) }
            : null),
        activeComparison: () => (active && comparison
            ? { tourId: "t", publicationId, repo, comparison, step: steps[current] }
            : null),
    };
}

function fixture() {
    const root = repository();
    fs.writeFileSync(path.join(root, "a.js"), lines(10));
    const base = commit(root, "base");
    const changed = lines(10).split("\n");
    changed[4] = "changed 5";
    fs.writeFileSync(path.join(root, "a.js"), changed.join("\n"));
    const target = commit(root, "change");
    return { root, base, target, file: path.join(root, "a.js") };
}

test("a revisions Step diff compares base with the saved file and selects the step", async () => {
    const { root, base, target, file } = fixture();
    try {
        const vscode = fakeVscode();
        const tour = fakeTour({
            repo: root,
            comparison: { kind: "revisions", label: "main...HEAD", base, target, renames: {}, renamesComplete: true },
            steps: [{ file, startLine: 4, endLine: 6 }],
        });
        const result = await createStepDiff({ vscode, tour, history, revisionUri }).open({});
        assert.equal(result.ok, true);
        assert.equal(result.result.savedDiffersFromTarget, false);
        assert.equal(result.result.noChangesInRange, false);
        const [command, left, right, title, options] = vscode.executed[0];
        assert.equal(command, "vscode.diff");
        assert.deepEqual(left, { scheme: "porthole-rev", repo: root, oid: base, path: "a.js" });
        assert.deepEqual(right, { scheme: "file", fsPath: file });
        assert.equal(title, "a.js — main...HEAD");
        assert.equal(options.viewColumn, -2);
        assert.deepEqual(options.selection, new Range(3, 0, 6, 0), "end-exclusive range includes line 6");
        assert.equal(tour.moved(), 0, "opening a diff never moves the Tour");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a saved file that differs from the target is labelled and offers the recorded side", async () => {
    const { root, base, target, file } = fixture();
    try {
        fs.appendFileSync(file, "later edit\n");
        const vscode = fakeVscode({ dirty: [file] });
        const tour = fakeTour({
            repo: root,
            comparison: { kind: "revisions", label: "main...HEAD", base, target, renames: {}, renamesComplete: true },
            steps: [{ file, startLine: 1, endLine: 2 }],
        });
        const stepDiff = createStepDiff({ vscode, tour, history, revisionUri });
        const saved = await stepDiff.open({});
        assert.equal(saved.result.savedDiffersFromTarget, true);
        assert.equal(saved.result.noChangesInRange, true);
        assert.match(saved.result.title, /current file differs from [0-9a-f]{7} \(unsaved edits shown\)$/);
        assert.ok(vscode.messages.some(([, text, button]) => /differs from/.test(text) && /^Compare with/.test(button)));

        const recorded = await stepDiff.open({ side: "target" });
        assert.equal(recorded.result.side, "target");
        assert.deepEqual(vscode.executed[1][2], { scheme: "porthole-rev", repo: root, oid: target, path: "a.js" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("live comparisons, renames, deleted files and root commits pick the right sides", async () => {
    const root = repository();
    try {
        fs.writeFileSync(path.join(root, "old.js"), lines(30, "kept"));
        const rootCommit = commit(root, "root");
        git(root, ["mv", "old.js", "new.js"]);
        fs.appendFileSync(path.join(root, "new.js"), "added\n");
        const file = path.join(root, "new.js");

        const vscode = fakeVscode();
        const live = await createStepDiff({
            vscode,
            tour: fakeTour({
                repo: root,
                comparison: { kind: "live", label: "uncommitted changes", base: rootCommit, target: null, renames: { "new.js": "old.js" }, renamesComplete: true },
                steps: [{ file, startLine: 31, endLine: 31 }],
            }),
            history,
            revisionUri,
        }).open({});
        assert.equal(live.ok, true);
        assert.equal(vscode.executed[0][1].path, "old.js");
        assert.match(live.result.title, /^new\.js — Live working changes since [0-9a-f]{7}$/);

        const rootDiff = await createStepDiff({
            vscode,
            tour: fakeTour({
                repo: root,
                comparison: { kind: "revisions", label: "root", base: null, target: rootCommit, renames: {}, renamesComplete: true },
                steps: [{ file: path.join(root, "old.js"), startLine: 1, endLine: 1 }],
            }),
            history,
            revisionUri,
            exists: () => false,
        }).open({});
        assert.equal(rootDiff.ok, true);
        assert.equal(vscode.executed[1][1].oid, "empty");
        assert.equal(vscode.executed[1][2].oid, "empty");
        assert.match(rootDiff.result.title, /file no longer exists/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing commits, unloaded Tours and Tours without comparisons are refused plainly", async () => {
    const { root, base, file } = fixture();
    try {
        const vscode = fakeVscode();
        const missing = await createStepDiff({
            vscode,
            tour: fakeTour({
                repo: root,
                comparison: { kind: "revisions", label: "x", base, target: "f".repeat(40), renames: {}, renamesComplete: true },
                steps: [{ file, startLine: 1, endLine: 1 }],
            }),
            history,
            revisionUri,
        }).open({});
        assert.equal(missing.reason, "missing-object");
        assert.match(missing.error, /isn't available in this clone; fetch it/);

        const plain = await createStepDiff({
            vscode,
            tour: fakeTour({ repo: root, comparison: null, steps: [{ file, startLine: 1 }] }),
            history,
            revisionUri,
        }).open({});
        assert.equal(plain.reason, "no-comparison");

        const unloaded = await createStepDiff({
            vscode,
            tour: fakeTour({ repo: root, comparison: null, steps: [{ file, startLine: 1 }] }),
            history,
            revisionUri,
        }).open({ tourId: "other" });
        assert.equal(unloaded.reason, "not-loaded");

        const none = await createStepDiff({
            vscode,
            tour: fakeTour({ repo: root, comparison: null, steps: [], active: false }),
            history,
            revisionUri,
        }).open({});
        assert.equal(none.reason, "no-active-tour");
        assert.equal(vscode.executed.length, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a file added by the comparison diffs against an empty left side, not an error message", async () => {
    const { root, base, file } = fixture();
    try {
        const added = path.join(root, "added.js");
        fs.writeFileSync(added, lines(3));
        const vscode = fakeVscode();
        const result = await createStepDiff({
            vscode,
            tour: fakeTour({
                repo: root,
                comparison: { kind: "live", label: "uncommitted changes", base, target: null, renames: {}, renamesComplete: true },
                steps: [{ file: added, startLine: 1, endLine: 3 }, { file, startLine: 1 }],
            }),
            history,
            revisionUri,
        }).open({});
        assert.equal(result.ok, true);
        assert.deepEqual(vscode.executed[0][1], { scheme: "porthole-rev", repo: root, oid: "empty", path: "added.js" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an 8.3 short path inside the repository maps to git's path", { skip: process.platform !== "win32" }, async (t) => {
    const root = repository();
    try {
        const longDir = path.join(root, "a-very-long-directory-name");
        fs.mkdirSync(longDir);
        const file = path.join(longDir, "file.js");
        fs.writeFileSync(file, "x\n");
        const shortDir = execFileSync(
            "cmd",
            ["/d", "/s", "/c", `"for %I in ("${longDir}") do @echo %~sI"`],
            { encoding: "utf8", windowsVerbatimArguments: true },
        ).trim();
        if (!shortDir || /a-very-long-directory-name$/i.test(shortDir)) {
            t.skip("8.3 names are disabled on this volume");
            return;
        }
        assert.equal(
            history.toRepoRelative(root, path.join(root, path.basename(shortDir), "file.js")),
            "a-very-long-directory-name/file.js",
            "a short name below a long repository root is not taken literally",
        );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("very different files diff within bounded memory, and beyond the edit cap report too-large", async () => {
    const root = repository();
    try {
        fs.writeFileSync(path.join(root, "a.js"), lines(1000, "old"));
        const base = commit(root, "base");
        fs.writeFileSync(path.join(root, "a.js"), lines(1000, "new"));
        const before = process.memoryUsage().rss;
        const within = await history.changedRanges(root, { kind: "live", base, target: null }, "a.js");
        assert.equal(within.ok, true);
        assert.deepEqual(within.hunks, [{ start: 1, end: 1000, kind: "modified", removedLines: 1000 }]);
        assert.ok(process.memoryUsage().rss - before < 64 * 1024 * 1024, "no quadratic map snapshots");

        fs.writeFileSync(path.join(root, "a.js"), lines(1500, "other"));
        const beyond = await history.changedRanges(root, { kind: "live", base, target: null }, "a.js");
        assert.deepEqual(beyond, { ok: false, reason: "too-large" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- change markers -----------------------------------------------------------

function markerEditor(file, { isDirty = false, lineCount = 10, version = 1 } = {}) {
    const set = new Map();
    return {
        set,
        document: { uri: { scheme: "file", fsPath: file }, isDirty, lineCount, version },
        setDecorations(type, ranges) { set.set(type, ranges); },
    };
}

test("change markers mark modified, added and removed lines and hide on dirty buffers", async () => {
    const root = repository();
    try {
        fs.writeFileSync(path.join(root, "a.js"), lines(10));
        const base = commit(root, "base");
        const next = lines(10).split("\n");
        next[2] = "modified 3";
        next.splice(6, 2);
        next.splice(0, 0, "added first");
        fs.writeFileSync(path.join(root, "a.js"), next.join("\n"));
        const file = path.join(root, "a.js");

        const vscode = fakeVscode();
        const tour = fakeTour({
            repo: root,
            comparison: { kind: "live", label: "uncommitted changes", base, target: null, renames: {}, renamesComplete: true },
            steps: [{ file, startLine: 1, endLine: 1 }],
        });
        const markers = createChangeMarkers({ vscode, tour, history });
        const [added, modified, deleted] = vscode.decorations;
        assert.equal(added.options.overviewRulerColor.id, "editorOverviewRuler.addedForeground");

        const editor = markerEditor(file);
        vscode.window.visibleTextEditors = [editor];
        await markers.refresh();
        assert.deepEqual(editor.set.get(added).map((d) => d.range.startLine), [0]);
        assert.deepEqual(editor.set.get(modified).map((d) => [d.range.startLine, d.range.endLine]), [[3, 3]]);
        assert.equal(editor.set.get(deleted).length, 1);
        assert.match(editor.set.get(deleted)[0].hoverMessage.value, /2 lines removed/);
        assert.deepEqual(editor.set.get(deleted)[0].hoverMessage.isTrusted, { enabledCommands: ["porthole.tour.diff"] });

        editor.document.isDirty = true;
        editor.document.version = 2;
        await markers.refresh();
        assert.equal(editor.set.get(added).length, 0, "dirty buffers lose their markers");

        editor.document.isDirty = false;
        editor.document.version = 3;
        await markers.refresh();
        assert.equal(editor.set.get(added).length, 1);
        markers.toggle();
        await markers.refresh();
        assert.equal(editor.set.get(added).length, 0, "the toggle hides markers");

        const other = markerEditor(path.join(root, "not-on-tour.js"));
        vscode.window.visibleTextEditors = [other];
        markers.toggle();
        await markers.refresh();
        assert.equal(other.set.size, 0, "files outside the Tour are untouched");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("change markers stay off without an active compared Tour or when the setting is off", async () => {
    const vscode = fakeVscode();
    vscode.workspace.getConfiguration = () => ({ get: () => false });
    const editor = markerEditor("C:\\nowhere.js");
    vscode.window.visibleTextEditors = [editor];
    const markers = createChangeMarkers({
        vscode,
        tour: fakeTour({ repo: "C:\\", comparison: { kind: "live", base: null, target: null, renames: {} }, steps: [{ file: "C:\\nowhere.js", startLine: 1 }] }),
        history: { changedRanges: async () => { throw new Error("must not be called"); }, toRepoRelative: () => "nowhere.js" },
    });
    await markers.refresh();
    assert.equal(editor.set.size, 0);
});

// --- line last-changes --------------------------------------------------------

test("line last-changes groups commits, marks unsaved lines and summarises for sending", async () => {
    const root = repository();
    try {
        fs.writeFileSync(path.join(root, "a.js"), lines(4));
        const first = commit(root, "first");
        const next = lines(4).split("\n");
        next[1] = "second change";
        fs.writeFileSync(path.join(root, "a.js"), next.join("\n"));
        const second = commit(root, "second");
        const buffer = next.slice();
        buffer[3] = "unsaved edit";
        const document = {
            uri: { fsPath: path.join(root, "a.js") },
            isDirty: true,
            getText: () => buffer.join("\n"),
        };
        const vscode = fakeVscode();
        const last = createLastChanges({ vscode, history, runGit, revisionUri });
        const collected = await last.collect(document, 1, 4);
        assert.equal(collected.ok, true);
        const byOid = new Map(collected.groups.map((group) => [group.oid, group]));
        assert.deepEqual(byOid.get(first).finalLines, [1, 3]);
        assert.deepEqual(byOid.get(second).finalLines, [2]);
        const pending = collected.groups.find((group) => group.uncommitted);
        assert.deepEqual(pending.finalLines, [4]);
        assert.equal(pending.author, null);

        const summary = last.summarise(collected);
        assert.deepEqual(summary.find((group) => group.uncommitted), {
            oid: null, author: null, time: null, summary: null, lines: [4], uncommitted: true, unsaved: true,
        });
        assert.equal(summary.find((group) => group.oid === second).summary, "second");

        await last.compare(collected.repo, byOid.get(second));
        const [, before, after] = vscode.executed[0];
        assert.equal(before.oid, first);
        assert.equal(after.oid, second);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("line last-changes reports files outside a repository", async () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "porthole-norepo-")));
    try {
        fs.writeFileSync(path.join(outside, "a.js"), "x\n");
        const last = createLastChanges({ vscode: fakeVscode(), history, runGit, revisionUri });
        const result = await last.collect({ uri: { fsPath: path.join(outside, "a.js") }, isDirty: false, getText: () => "x\n" }, 1, 1);
        assert.equal(result.ok, false);
        assert.match(result.error, /not in a git repository/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test("line ranges are compressed for display", () => {
    assert.equal(lineRanges([1, 2, 3, 5, 7, 8]), "1–3, 5, 7–8");
});
