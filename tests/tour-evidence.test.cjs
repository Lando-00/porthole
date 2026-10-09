const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vscode-extension", "src");

class EventEmitter {
    constructor() {
        this.listeners = new Set();
        this.event = (listener) => {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        };
    }

    fire(value) {
        for (const listener of this.listeners) listener(value);
    }
}

function fakeVscode({ repo, session, dirtyFiles, displays, warnings }) {
    const uri = (fsPath) => ({
        scheme: "file",
        fsPath,
        toString: () => `file:${fsPath}`,
    });
    return {
        EventEmitter,
        Uri: {
            file: uri,
            joinPath(base, ...parts) {
                return uri(path.join(base.fsPath, ...parts));
            },
        },
        Range: class Range {
            constructor(start, end) {
                this.start = start;
                this.end = end;
            }
        },
        Selection: class Selection {
            constructor(start, end) {
                this.start = start;
                this.end = end;
            }
        },
        TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
        commands: {
            async executeCommand() {},
            registerCommand: () => ({ dispose() {} }),
        },
        workspace: {
            workspaceFolders: [
                { uri: uri(repo) },
                { uri: uri(session.dir) },
            ],
            getConfiguration() {
                return {
                    get(key, fallback) {
                        if (key === "annotations.autoRevealFocus") return false;
                        return fallback;
                    },
                };
            },
            async openTextDocument(fileUri) {
                const content = fs.readFileSync(fileUri.fsPath, "utf8");
                const lines = content.split(/\r?\n/);
                return {
                    uri: fileUri,
                    isDirty: dirtyFiles.has(fileUri.fsPath),
                    lineCount: lines.length,
                    lineAt(index) {
                        return { text: lines[index] || "" };
                    },
                };
            },
        },
        window: {
            visibleTextEditors: [],
            async showTextDocument(document) {
                displays.push(document.uri.fsPath);
                return {
                    document,
                    setDecorations() {},
                    revealRange() {},
                    selection: null,
                };
            },
            showInformationMessage() {},
            showWarningMessage(message) {
                warnings.push(message);
            },
        },
    };
}

function loadActualModules({
    repo,
    session,
    dirtyFiles = new Set(),
    repoModule = null,
}) {
    const displays = [];
    const warnings = [];
    const vscode = fakeVscode({ repo, session, dirtyFiles, displays, warnings });
    const diagnostics = {
        publish() {},
        dispose() {},
    };
    const reveal = {
        clampRange(_document, startLine, endLine) {
            return {
                start: { line: startLine - 1, character: 0 },
                end: { line: endLine - 1, character: 0 },
            };
        },
    };
    const sessionModule = {
        findWorkspaceSession: () => session,
        sessionRoot: () => path.dirname(session.dir),
    };
    const mocks = new Map([
        ["vscode", vscode],
        [path.join(SRC, "diagnostics.js"), diagnostics],
        [path.join(SRC, "reveal.js"), reveal],
        [path.join(SRC, "session.js"), sessionModule],
        [path.join(SRC, "log.js"), { diag() {} }],
    ]);
    if (repoModule) mocks.set(path.join(SRC, "repo.js"), repoModule);
    const actualFiles = [
        "anchors.js",
        "repo.js",
        "tour.js",
        "tourstore.js",
        "annotations.js",
        "reviews.js",
    ].map((name) => path.join(SRC, name));
    for (const file of actualFiles) delete require.cache[file];

    const originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
        if (mocks.has(request)) return mocks.get(request);
        let resolved;
        try {
            resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
            resolved = null;
        }
        if (resolved && mocks.has(resolved)) return mocks.get(resolved);
        return originalLoad.call(this, request, parent, isMain);
    };

    let anchors;
    let tour;
    let tourstore;
    let annotations;
    let reviews;
    try {
        anchors = require(path.join(SRC, "anchors.js"));
        tour = require(path.join(SRC, "tour.js"));
        tourstore = require(path.join(SRC, "tourstore.js"));
        annotations = require(path.join(SRC, "annotations.js"));
        reviews = require(path.join(SRC, "reviews.js"));
    } finally {
        Module._load = originalLoad;
    }

    tour.setPersistenceHandlers({
        publication: tourstore.publish,
        progress: tourstore.scheduleProgress,
    });
    return {
        anchors,
        tour,
        tourstore,
        annotations,
        reviews,
        displays,
        warnings,
    };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-evidence-"));
    const repo = path.join(root, "repo");
    const session = {
        id: "session-current",
        dir: path.join(root, "sessions", "session-current"),
    };
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(session.dir, { recursive: true });
    return { root, repo, session };
}

function runGit(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

test("publication captures real anchors and progress never rewrites authored Tour JSON", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "policy.js");
    fs.writeFileSync(file, "const allowed = false;\n", "utf8");
    const loaded = loadActualModules({ repo, session });

    try {
        const result = await loaded.tour.upsert({
            tourId: "policy",
            title: "Policy",
            sourceRepo: repo,
            activate: false,
            steps: [{
                file,
                startLine: 1,
                endLine: 1,
                stepTitle: "Policy gate",
                narration: "This value blocks the request.",
                severity: "info",
                anchor: { sha256: "model-supplied-anchor" },
            }],
        });
        assert.equal(result.ok, true);

        const canonicalFile = path.join(session.dir, "porthole", "tours", "policy.json");
        const canonical = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
        const originalAnchor = loaded.anchors.anchorFor(file, 1, 1);
        assert.deepEqual(canonical.steps[0].anchor, originalAnchor);
        assert.notEqual(canonical.steps[0].anchor.sha256, "model-supplied-anchor");
        assert.equal(canonical.repo, path.resolve(repo));
        assert.equal(canonical.publication.repo, path.resolve(repo));
        assert.equal(canonical.publication.commit, null);
        assert.match(canonical.publication.id, /^[0-9a-f-]{36}$/);
        assert.match(canonical.publication.at, /^\d{4}-\d{2}-\d{2}T/);

        const authoredBytes = fs.readFileSync(canonicalFile, "utf8");
        fs.writeFileSync(file, "const allowed = true;\n", "utf8");
        assert.equal((await loaded.tour.activateTour("policy")).ok, true);
        loaded.tourstore.flush();

        assert.equal(fs.readFileSync(canonicalFile, "utf8"), authoredBytes);
        const progress = JSON.parse(
            fs.readFileSync(
                path.join(session.dir, "porthole", "tour-progress", "policy.json"),
                "utf8",
            ),
        );
        assert.equal(progress.publicationId, canonical.publication.id);
        assert.equal(progress.current, 0);

        loaded.tour.closeAll();
        assert.deepEqual(await loaded.tourstore.restore(), { restored: 1 });
        const restored = loaded.tour.getTour("policy");
        assert.equal(loaded.tour.getLibrary().activeTourId, null);
        assert.equal(restored.current, 0);
        assert.equal(restored.steps[0].status, "changed");
        assert.deepEqual(restored.steps[0].anchor, originalAnchor);
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("explicit replacement creates new publication evidence without rewriting Tour identity history", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "replacement.js");
    fs.writeFileSync(file, "export const version = 1;\n", "utf8");
    const loaded = loadActualModules({ repo, session });

    try {
        assert.equal((await loaded.tour.upsert({
            tourId: "replacement",
            title: "First publication",
            sourceRepo: repo,
            activate: false,
            steps: [{
                file,
                startLine: 1,
                stepTitle: "Version one",
                narration: "The first publication.",
            }],
        })).ok, true);
        const canonicalFile = path.join(
            session.dir,
            "porthole",
            "tours",
            "replacement.json",
        );
        const first = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));

        fs.writeFileSync(file, "export const version = 2;\n", "utf8");
        assert.equal((await loaded.tour.upsert({
            tourId: "replacement",
            title: "Second publication",
            sourceRepo: repo,
            replace: true,
            activate: false,
            steps: [{
                file,
                startLine: 1,
                stepTitle: "Version two",
                narration: "The replacement publication.",
            }],
        })).ok, true);
        const second = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));

        assert.equal(second.createdAt, first.createdAt);
        assert.notEqual(second.publication.id, first.publication.id);
        assert.notDeepEqual(second.steps[0].anchor, first.steps[0].anchor);
        assert.equal(second.current, -1);
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a dirty target saves the publication but blocks display and cursor movement", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "dirty.js");
    fs.writeFileSync(file, "export const value = 1;\nexport const other = 2;\n", "utf8");
    const dirtyFiles = new Set([file]);
    const loaded = loadActualModules({ repo, session, dirtyFiles });

    try {
        const result = await loaded.tour.upsert({
            tourId: "dirty-target",
            title: "Dirty target",
            sourceRepo: repo,
            steps: [{
                file,
                startLine: 1,
                stepTitle: "Value",
                narration: "The value is defined here.",
            }, {
                file,
                startLine: 2,
                stepTitle: "Other value",
                narration: "The second value is defined here.",
            }],
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "requires-save");
        assert.equal(result.result.saved, true);
        assert.equal(result.result.displayed, false);
        assert.equal(fs.existsSync(
            path.join(session.dir, "porthole", "tours", "dirty-target.json"),
        ), true);
        assert.equal(loaded.tour.getTour("dirty-target").current, -1);
        assert.equal(loaded.tour.getLibrary().activeTourId, null);
        assert.deepEqual(loaded.displays, []);
        assert.match(loaded.warnings[0], /save .*dirty\.js/i);

        dirtyFiles.delete(file);
        const retry = await loaded.tour.activateTour("dirty-target");
        assert.equal(retry.ok, true);
        assert.equal(loaded.tour.getTour("dirty-target").current, 0);
        assert.equal(loaded.tour.getLibrary().activeTourId, "dirty-target");
        assert.deepEqual(loaded.displays, [file]);

        dirtyFiles.add(file);
        const blockedNavigation = await loaded.tour.goto(1);
        assert.equal(blockedNavigation.ok, false);
        assert.equal(blockedNavigation.reason, "requires-save");
        assert.equal(loaded.tour.getTour("dirty-target").current, 0);
        assert.deepEqual(loaded.displays, [file]);

        dirtyFiles.delete(file);
        assert.equal((await loaded.tour.goto(1)).ok, true);
        assert.equal(loaded.tour.getTour("dirty-target").current, 1);
        assert.deepEqual(loaded.displays, [file, file]);
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Tour listing refreshes the publication revision advisory on demand", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "source.js");
    fs.writeFileSync(file, "export const source = true;\n", "utf8");
    runGit(repo, ["init", "--quiet"]);
    runGit(repo, ["config", "user.name", "Porthole Tests"]);
    runGit(repo, ["config", "user.email", "porthole@example.invalid"]);
    runGit(repo, ["add", "source.js"]);
    runGit(repo, ["commit", "--quiet", "-m", "source"]);
    const publishedCommit = runGit(repo, ["rev-parse", "HEAD"]);
    const loaded = loadActualModules({ repo, session });

    try {
        assert.equal((await loaded.tour.upsert({
            tourId: "revision",
            title: "Revision",
            sourceRepo: repo,
            activate: false,
            steps: [{
                file,
                startLine: 1,
                stepTitle: "Source",
                narration: "The source stays unchanged.",
            }],
        })).ok, true);

        const canonical = JSON.parse(
            fs.readFileSync(
                path.join(session.dir, "porthole", "tours", "revision.json"),
                "utf8",
            ),
        );
        assert.equal(canonical.publication.commit, publishedCommit);
        assert.equal((await loaded.tourstore.list({})).result.tours[0].revisionState, "same-revision");

        fs.writeFileSync(path.join(repo, "unrelated.txt"), "new commit\n", "utf8");
        runGit(repo, ["add", "unrelated.txt"]);
        runGit(repo, ["commit", "--quiet", "-m", "unrelated"]);

        const refreshed = await loaded.tourstore.list({});
        assert.equal(refreshed.result.tours[0].revisionState, "revision-changed");
        assert.equal(loaded.tour.getTour("revision").revisionState, "revision-changed");
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("ordinary Tour navigation does not perform revision lookups", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "navigation.js");
    fs.writeFileSync(file, "export const first = 1;\nexport const second = 2;\n", "utf8");
    const commit = "a".repeat(40);
    let publicationLookups = 0;
    let refreshLookups = 0;
    const normaliseRepo = (value) => (value ? path.resolve(value) : null);
    const repoModule = {
        normaliseRepo,
        normaliseSlug: (value) =>
            String(value).trim().toLowerCase().replace(/[^\w-]+/g, "-"),
        async gitRevision(value) {
            publicationLookups += 1;
            return { repo: normaliseRepo(value), branch: "main", commit };
        },
        async gitRevisions(repositories) {
            refreshLookups += 1;
            return new Map(
                repositories.map((value) => [
                    normaliseRepo(value),
                    { repo: normaliseRepo(value), branch: "main", commit },
                ]),
            );
        },
        revisionState: (publication, revision) =>
            publication?.commit && publication.commit === revision?.commit
                ? "same-revision"
                : "unknown",
        storedPath: (value) => value,
        absoluteFile: (value) => value,
    };
    const loaded = loadActualModules({ repo, session, repoModule });

    try {
        assert.equal((await loaded.tour.upsert({
            tourId: "navigation",
            sourceRepo: repo,
            activate: false,
            steps: [{
                file,
                startLine: 1,
                stepTitle: "First",
                narration: "First step.",
            }, {
                file,
                startLine: 2,
                stepTitle: "Second",
                narration: "Second step.",
            }],
        })).ok, true);
        assert.equal(publicationLookups, 1);
        assert.equal(refreshLookups, 0);

        assert.equal((await loaded.tourstore.activateTour({ tourId: "navigation" })).ok, true);
        assert.equal(refreshLookups, 1);
        assert.equal((await loaded.tourstore.activateTour({
            tourId: "navigation",
            step: 1,
        })).ok, true);
        assert.equal((await loaded.tour.goto(0)).ok, true);
        assert.equal(refreshLookups, 1);
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Tour and loaded-review round trips preserve inherited evidence and authored severity", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "review.js");
    fs.writeFileSync(file, "const enabled = false;\n", "utf8");
    const loaded = loadActualModules({ repo, session });

    try {
        assert.equal((await loaded.tour.upsert({
            tourId: "review-source",
            title: "Review source",
            sourceRepo: repo,
            activate: false,
            steps: [{
                file,
                startLine: 1,
                stepTitle: "Disabled flag",
                narration: "This flag disables the feature.",
                severity: "info",
            }],
        })).ok, true);
        const originalAnchor = loaded.tour.getTour("review-source").steps[0].anchor;

        fs.writeFileSync(file, "const enabled = true;\n", "utf8");
        loaded.tour.closeAll();
        assert.deepEqual(await loaded.tourstore.restore(), { restored: 1 });
        assert.equal((await loaded.tour.activateTour("review-source")).ok, true);

        const firstSave = loaded.reviews.save({ slug: "tour-review" });
        assert.equal(firstSave.ok, true);
        const firstRecord = JSON.parse(fs.readFileSync(firstSave.result.file, "utf8"));
        assert.deepEqual(firstRecord.findings[0].anchor, originalAnchor);
        assert.equal(firstRecord.findings[0].severity, "info");
        assert.equal(firstRecord.findings[0].message, "Disabled flag");
        assert.equal(firstRecord.findings[0].narration, "This flag disables the feature.");

        loaded.tour.closeAll();
        const loadResult = await loaded.reviews.load({ slug: "tour-review" });
        assert.equal(loadResult.ok, true);
        const displayed = loaded.annotations.getState().entries[0];
        assert.equal(displayed.severity, "warn");
        assert.match(displayed.message, /changed since the review was saved/);

        const secondSave = loaded.reviews.save({ slug: "roundtrip-review" });
        assert.equal(secondSave.ok, true);
        const secondRecord = JSON.parse(fs.readFileSync(secondSave.result.file, "utf8"));
        assert.deepEqual(secondRecord.findings[0].anchor, originalAnchor);
        assert.equal(secondRecord.findings[0].severity, "info");
        assert.equal(secondRecord.findings[0].message, "Disabled flag");
        assert.equal(secondRecord.findings[0].narration, "This flag disables the feature.");
        assert.doesNotMatch(secondRecord.findings[0].message, /changed since/);
        assert.equal(secondRecord.repo, path.resolve(repo));
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("listing a loaded Tour refreshes advisory metadata without re-anchoring or navigating it", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "loaded.js");
    fs.writeFileSync(file, "const value = 1;\n");
    const loaded = loadActualModules({ repo, session });
    const originalResolve = loaded.anchors.resolve;
    try {
        assert.equal((await loaded.tour.upsert({
            tourId: "loaded",
            sourceRepo: repo,
            activate: false,
            steps: [{ file, startLine: 1, stepTitle: "Original" }],
        })).ok, true);
        const before = loaded.tour.getTour("loaded");
        fs.writeFileSync(file, "const value = 2;\n");
        let resolutions = 0;
        loaded.anchors.resolve = (...args) => {
            resolutions += 1;
            return originalResolve(...args);
        };
        await loaded.tourstore.list({});
        assert.equal(resolutions, 0);
        assert.equal(loaded.tour.getTour("loaded"), before);
        assert.equal(loaded.displays.length, 0);
    } finally {
        loaded.anchors.resolve = originalResolve;
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a different saved publication is reported but loaded only on explicit activation", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "saved.js");
    fs.writeFileSync(file, "const value = 1;\n");
    const loaded = loadActualModules({ repo, session });
    try {
        assert.equal((await loaded.tour.upsert({
            tourId: "saved",
            sourceRepo: repo,
            activate: false,
            steps: [{ file, startLine: 1, stepTitle: "Original" }],
        })).ok, true);
        const before = loaded.tour.getTour("saved");
        const savedFile = path.join(session.dir, "porthole", "tours", "saved.json");
        const record = JSON.parse(fs.readFileSync(savedFile, "utf8"));
        record.publication.id = "new-publication";
        record.steps[0].stepTitle = "Updated elsewhere";
        fs.writeFileSync(savedFile, JSON.stringify(record));
        const list = await loaded.tourstore.list({});
        assert.equal(list.result.tours[0].savedPublicationChanged, true);
        assert.equal(loaded.tour.getTour("saved"), before);
        assert.equal(loaded.displays.length, 0);
        assert.equal((await loaded.tourstore.activateTour({ tourId: "saved" })).ok, true);
        assert.equal(loaded.tour.getTour("saved").steps[0].stepTitle, "Updated elsewhere");
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("rebinding during publication cannot write a Tour into a different session folder", async () => {
    for (const changeId of [true, false]) {
        const { root, repo, session } = fixture();
        const originalDir = session.dir;
        const file = path.join(repo, "binding.js");
        fs.writeFileSync(file, "const value = 1;\n");
        const loaded = loadActualModules({ repo, session });
        const otherDir = path.join(root, "other", changeId ? "session-other" : session.id);
        fs.mkdirSync(otherDir, { recursive: true });
        loaded.tour.setPersistenceHandlers({
            publication(entry, options) {
                if (changeId) session.id = "session-other";
                session.dir = otherDir;
                return loaded.tourstore.publish(entry, options);
            },
            progress: loaded.tourstore.scheduleProgress,
        });

        try {
            const result = await loaded.tour.upsert({
                tourId: "binding",
                sourceRepo: repo,
                activate: false,
                steps: [{ file, startLine: 1, stepTitle: "Bound source" }],
            });
            assert.equal(result.ok, false);
            assert.match(result.error, /session/i);
            assert.equal(fs.existsSync(path.join(originalDir, "porthole", "tours", "binding.json")), false);
            assert.equal(fs.existsSync(path.join(otherDir, "porthole", "tours", "binding.json")), false);
        } finally {
            loaded.tourstore.flush();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test("derived title collisions never replace a saved publication implicitly", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "collision.js");
    fs.writeFileSync(file, "const value = 1;\n");
    const loaded = loadActualModules({ repo, session });
    const payload = {
        title: "a".repeat(64),
        sourceRepo: repo,
        activate: false,
        steps: [{ file, startLine: 1, stepTitle: "Original" }],
    };
    try {
        const first = await loaded.tour.upsert(payload);
        assert.equal(first.ok, true);
        const originalFile = first.result.file;
        const original = fs.readFileSync(originalFile, "utf8");
        const second = await loaded.tour.upsert(payload);
        assert.equal(second.ok, true);
        assert.notEqual(second.result.tourId, first.result.tourId);
        assert.equal(second.result.tourId.length, 64);
        loaded.tour.closeAll();
        const unloadedCollision = await loaded.tour.upsert(payload);
        assert.equal(unloadedCollision.ok, false);
        assert.match(unloadedCollision.error, /already saved/);
        assert.equal(fs.readFileSync(originalFile, "utf8"), original);
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
