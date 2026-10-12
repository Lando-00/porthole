const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
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

function fakeVscode({ repo, session, displays }) {
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
                return { get: (_key, fallback) => fallback };
            },
            async openTextDocument(fileUri) {
                const lines = fs.readFileSync(fileUri.fsPath, "utf8").split(/\r?\n/);
                return {
                    uri: fileUri,
                    isDirty: false,
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
            showWarningMessage() {},
        },
    };
}

function loadActualModules({ repo, session }) {
    const displays = [];
    const logs = [];
    const vscode = fakeVscode({ repo, session, displays });
    const mocks = new Map([
        ["vscode", vscode],
        [
            path.join(SRC, "diagnostics.js"),
            { publish() {}, dispose() {} },
        ],
        [
            path.join(SRC, "reveal.js"),
            {
                clampRange(_document, startLine, endLine) {
                    return {
                        start: { line: startLine - 1, character: 0 },
                        end: { line: endLine - 1, character: 0 },
                    };
                },
            },
        ],
        [
            path.join(SRC, "session.js"),
            {
                findWorkspaceSession: () => session,
                sessionRoot: () => path.dirname(session.dir),
            },
        ],
        [path.join(SRC, "log.js"), { diag: (message) => logs.push(message) }],
    ]);
    for (const name of ["anchors.js", "repo.js", "tour.js", "tourstore.js"]) {
        delete require.cache[path.join(SRC, name)];
    }

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

    let tour;
    let tourstore;
    try {
        tour = require(path.join(SRC, "tour.js"));
        tourstore = require(path.join(SRC, "tourstore.js"));
    } finally {
        Module._load = originalLoad;
    }
    tour.setPersistenceHandlers({
        publication: tourstore.publish,
        progress: tourstore.scheduleProgress,
    });
    return { tour, tourstore, displays, logs };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(ROOT, ".tour-comparison-"));
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

function initialiseRepo(repo, file) {
    runGit(repo, ["init", "--quiet"]);
    runGit(repo, ["config", "user.name", "Porthole Tests"]);
    runGit(repo, ["config", "user.email", "porthole@example.invalid"]);
    runGit(repo, ["add", path.basename(file)]);
    runGit(repo, ["commit", "--quiet", "-m", "initial"]);
    return runGit(repo, ["rev-parse", "HEAD"]);
}

function liveComparison(overrides = {}) {
    return {
        kind: "live",
        label: "Working changes",
        base: "a".repeat(40),
        target: null,
        renames: {},
        renamesComplete: true,
        ...overrides,
    };
}

function tourPayload(file, comparison, overrides = {}) {
    return {
        tourId: overrides.tourId || "comparison-tour",
        title: "Recorded comparison",
        sourceRepo: overrides.sourceRepo,
        activate: overrides.activate ?? false,
        steps: [
            {
                file,
                startLine: 1,
                endLine: 1,
                stepTitle: "First",
                narration: "The first step.",
            },
            {
                file,
                startLine: 2,
                endLine: 2,
                stepTitle: "Second",
                narration: "The second step.",
            },
        ],
        ...(comparison === undefined ? {} : { comparison }),
    };
}

test("Recorded comparison persists and survives every Tour lifecycle operation", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "source.js");
    fs.writeFileSync(file, "export const first = 1;\nexport const second = 2;\n", "utf8");
    const target = initialiseRepo(repo, file);
    const expected = {
        kind: "revisions",
        label: "main...feature",
        base: null,
        target,
        renames: { "source.js": "old/source.js" },
        renamesComplete: true,
    };
    let loaded = loadActualModules({ repo, session });

    try {
        const result = await loaded.tour.upsert(tourPayload(file, {
            ...expected,
            label: `  ${expected.label}  `,
            renamesComplete: undefined,
            ignored: "not stored",
        }, {
            sourceRepo: repo,
            activate: true,
        }));
        assert.equal(result.ok, true);
        assert.equal(result.result.comparisonRecorded, true);
        assert.deepEqual(result.result.publication.comparison, expected);

        const canonicalFile = path.join(
            session.dir,
            "porthole",
            "tours",
            "comparison-tour.json",
        );
        let canonical = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
        assert.deepEqual(canonical.publication.comparison, expected);
        assert.deepEqual(loaded.tour.activeComparison(), {
            tourId: "comparison-tour",
            publicationId: canonical.publication.id,
            repo: path.resolve(repo),
            comparison: expected,
            step: {
                file,
                startLine: 1,
                endLine: 1,
            },
        });
        assert.deepEqual(loaded.tour.tourComparison("comparison-tour"), {
            tourId: "comparison-tour",
            publicationId: canonical.publication.id,
            repo: path.resolve(repo),
            comparison: expected,
            steps: [
                { file, startLine: 1, endLine: 1 },
                { file, startLine: 2, endLine: 2 },
            ],
        });

        const publicationBytes = fs.readFileSync(canonicalFile, "utf8");
        await loaded.tour.step(1);
        loaded.tourstore.flush();
        assert.equal(fs.readFileSync(canonicalFile, "utf8"), publicationBytes);

        let listed = await loaded.tourstore.list({});
        assert.deepEqual(listed.result.tours[0].comparison, expected);
        assert.deepEqual(
            loaded.tour.getTour("comparison-tour").publication.comparison,
            expected,
        );

        fs.writeFileSync(path.join(repo, "later.txt"), "later\n", "utf8");
        runGit(repo, ["add", "later.txt"]);
        runGit(repo, ["commit", "--quiet", "-m", "later"]);
        listed = await loaded.tourstore.list({});
        assert.equal(listed.result.tours[0].revisionState, "revision-changed");
        assert.deepEqual(listed.result.tours[0].comparison, expected);

        assert.equal((await loaded.tourstore.setArchived({
            tourId: "comparison-tour",
            archived: true,
        })).ok, true);
        listed = await loaded.tourstore.list({ includeArchived: true });
        assert.equal(listed.result.tours[0].loaded, false);
        assert.deepEqual(listed.result.tours[0].comparison, expected);
        canonical = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
        assert.deepEqual(canonical.publication.comparison, expected);

        assert.equal((await loaded.tourstore.setArchived({
            tourId: "comparison-tour",
            archived: false,
        })).ok, true);
        assert.deepEqual(
            loaded.tour.getTour("comparison-tour").publication.comparison,
            expected,
        );
        assert.equal((await loaded.tour.activateTour("comparison-tour")).ok, true);
        assert.equal(loaded.tour.close("comparison-tour").ok, true);
        assert.equal(loaded.tour.activeComparison(), null);
        assert.deepEqual(
            loaded.tour.tourComparison("comparison-tour").comparison,
            expected,
        );

        canonical = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
        const newer = {
            ...expected,
            label: "newer saved publication",
            renames: { "source.js": "legacy/source.js" },
        };
        canonical.publication.id = "newer-publication";
        canonical.publication.comparison = newer;
        fs.writeFileSync(canonicalFile, JSON.stringify(canonical), "utf8");
        assert.equal((await loaded.tourstore.activateTour({
            tourId: "comparison-tour",
            step: 0,
        })).ok, true);
        assert.deepEqual(
            loaded.tour.getTour("comparison-tour").publication.comparison,
            newer,
        );

        loaded.tourstore.flush();
        loaded.tour.closeAll();
        loaded = loadActualModules({ repo, session });
        assert.deepEqual(await loaded.tourstore.restore(), { restored: 1 });
        assert.deepEqual(
            loaded.tour.getTour("comparison-tour").publication.comparison,
            newer,
        );
        assert.deepEqual(
            (await loaded.tourstore.list({})).result.tours[0].comparison,
            newer,
        );
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("comparison-less Tours keep the existing publication format", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "plain.js");
    fs.writeFileSync(file, "const one = 1;\nconst two = 2;\n", "utf8");
    const loaded = loadActualModules({ repo, session });

    try {
        const result = await loaded.tour.upsert(tourPayload(file, undefined, {
            sourceRepo: repo,
        }));
        assert.equal(result.ok, true);
        assert.equal(
            Object.prototype.hasOwnProperty.call(result.result, "comparisonRecorded"),
            false,
        );
        const canonical = JSON.parse(
            fs.readFileSync(result.result.file, "utf8"),
        );
        assert.equal(
            Object.prototype.hasOwnProperty.call(canonical.publication, "comparison"),
            false,
        );
        assert.equal((await loaded.tourstore.list({})).result.tours[0].comparison, null);
        assert.equal(loaded.tour.tourComparison("comparison-tour"), null);
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("invalid Recorded comparisons refuse the whole publication", async (t) => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "invalid.js");
    fs.writeFileSync(file, "const one = 1;\nconst two = 2;\n", "utf8");
    const loaded = loadActualModules({ repo, session });
    const tooManyRenames = Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [
            `new/file-${index}.js`,
            `old/file-${index}.js`,
        ]),
    );
    const cases = [
        ["bad kind", liveComparison({ kind: "range" })],
        ["bad oid", liveComparison({ base: "ABC" })],
        ["live target", liveComparison({ target: "b".repeat(40) })],
        [
            "revision without target",
            liveComparison({ kind: "revisions", target: null }),
        ],
        ["empty label", liveComparison({ label: "   " })],
        ["long label", liveComparison({ label: "x".repeat(121) })],
        ["control label", liveComparison({ label: "bad\nlabel" })],
        ["dot rename", liveComparison({ renames: { "dir/../new.js": "old.js" } })],
        ["absolute rename", liveComparison({ renames: { "/new.js": "old.js" } })],
        ["backslash rename", liveComparison({ renames: { "dir\\new.js": "old.js" } })],
        ["drive rename", liveComparison({ renames: { "C:/new.js": "old.js" } })],
        ["too many renames", liveComparison({ renames: tooManyRenames })],
        ["renames non-object", liveComparison({ renames: [] })],
        ["renamesComplete non-boolean", liveComparison({ renamesComplete: "yes" })],
        ["comparison non-object", []],
    ];

    try {
        for (const [index, [name, comparison]] of cases.entries()) {
            await t.test(name, async () => {
                const tourId = `invalid-${index}`;
                const result = await loaded.tour.upsert(tourPayload(file, comparison, {
                    tourId,
                    sourceRepo: repo,
                }));
                assert.equal(result.ok, false);
                assert.match(result.error, /^invalid Recorded comparison: /);
                assert.equal(
                    fs.existsSync(path.join(
                        session.dir,
                        "porthole",
                        "tours",
                        `${tourId}.json`,
                    )),
                    false,
                );
            });
        }

        await t.test("comparison without sourceRepo", async () => {
            const result = await loaded.tour.upsert(tourPayload(
                file,
                liveComparison(),
                { tourId: "missing-repo", sourceRepo: null },
            ));
            assert.equal(result.ok, false);
            assert.match(result.error, /^invalid Recorded comparison: sourceRepo/);
            assert.equal(
                fs.existsSync(path.join(
                    session.dir,
                    "porthole",
                    "tours",
                    "missing-repo.json",
                )),
                false,
            );
        });
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("imports preserve valid comparisons and malformed stored comparisons are dropped", async () => {
    const { root, repo, session } = fixture();
    const file = path.join(repo, "stored.js");
    fs.writeFileSync(file, "const one = 1;\nconst two = 2;\n", "utf8");
    const loaded = loadActualModules({ repo, session });
    const comparison = liveComparison({
        label: "Imported working tree",
        renames: { "stored.js": "old/stored.js" },
    });

    try {
        const published = await loaded.tour.upsert(tourPayload(file, comparison, {
            tourId: "seed",
            sourceRepo: repo,
        }));
        assert.equal(published.ok, true);
        const seed = JSON.parse(fs.readFileSync(published.result.file, "utf8"));

        const historicalDir = path.join(root, "sessions", "session-old");
        const sourceFile = path.join(
            historicalDir,
            "porthole",
            "tours",
            "source.json",
        );
        fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
        fs.writeFileSync(sourceFile, JSON.stringify({
            ...seed,
            tourId: "source",
            sessionId: "session-old",
        }), "utf8");

        const imported = await loaded.tourstore.importTour({
            sourceSessionId: "session-old",
            sourceTourId: "source",
            targetTourId: "imported",
        });
        assert.equal(imported.ok, true);
        const importedRecord = JSON.parse(fs.readFileSync(imported.result.file, "utf8"));
        assert.deepEqual(importedRecord.publication.comparison, comparison);
        assert.deepEqual(
            loaded.tour.getTour("imported").publication.comparison,
            comparison,
        );

        const malformedFile = path.join(
            session.dir,
            "porthole",
            "tours",
            "malformed.json",
        );
        fs.writeFileSync(malformedFile, JSON.stringify({
            ...seed,
            tourId: "malformed",
            sessionId: session.id,
            publication: {
                ...seed.publication,
                id: "malformed-publication",
                comparison: {
                    ...comparison,
                    kind: "broken",
                },
            },
        }), "utf8");

        assert.deepEqual(await loaded.tourstore.restore(), { restored: 1 });
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                loaded.tour.getTour("malformed").publication,
                "comparison",
            ),
            false,
        );
        const malformedList = (await loaded.tourstore.list({})).result.tours.find(
            (entry) => entry.tourId === "malformed",
        );
        assert.equal(malformedList.comparison, null);
        assert.equal(loaded.tour.tourComparison("malformed"), null);
        assert.equal(
            loaded.logs.some((message) =>
                message.includes("dropped invalid Recorded comparison")),
            true,
        );
    } finally {
        loaded.tourstore.flush();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
