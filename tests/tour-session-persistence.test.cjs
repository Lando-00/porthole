const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vscode-extension", "src");
const TOURSTORE = path.join(SRC, "tourstore.js");

function loadTourstore({ session, workspaceSession, loadedTour = null, warningAnswer }) {
    const adopted = [];
    const tour = {
        setPersistHandler() {},
        getTour: () => loadedTour,
        getLibrary: () => ({ tours: [], activeTourId: null }),
        has: () => false,
        adopt(entry) {
            adopted.push(entry);
            return true;
        },
        async activateTour() {
            return { ok: true, result: {} };
        },
        unload: () => false,
    };
    const mocks = new Map([
        [
            "vscode",
            {
                commands: { registerCommand: () => ({ dispose() {} }) },
                window: {
                    showWarningMessage: async () => warningAnswer,
                    showInformationMessage() {},
                },
            },
        ],
        [path.join(SRC, "tour.js"), tour],
        [
            path.join(SRC, "session.js"),
            {
                findSession: () => session,
                findWorkspaceSession: () => workspaceSession,
                sessionRoot: () => path.dirname(session.dir),
            },
        ],
        [
            path.join(SRC, "anchors.js"),
            {
                tally: () => ({ resolved: 0, shifted: 0, changed: 0, missing: 0 }),
                resolve: (step, file) => ({
                    status: "resolved",
                    startLine: step.startLine,
                    endLine: step.endLine,
                    file,
                }),
                anchorFor: () => ({ hash: "anchor" }),
            },
        ],
        [
            path.join(SRC, "repo.js"),
            {
                projectFolder: () => "C:\\repo",
                gitHead: () => ({ branch: "main", commit: "abc" }),
                storedPath: (file) => file,
                absoluteFile: (file) => file,
            },
        ],
        [path.join(SRC, "log.js"), { diag() {} }],
    ]);

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

    delete require.cache[TOURSTORE];
    let tourstore;
    try {
        tourstore = require(TOURSTORE);
    } finally {
        Module._load = originalLoad;
    }
    return { tourstore, adopted };
}

function writeTour(sessionDir, tourId, sessionId, overrides = {}) {
    const file = path.join(sessionDir, "porthole", "tours", `${tourId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify({
            schema: 1,
            tourId,
            title: "Older session tour",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            sessionId,
            repo: "C:\\repo",
            branch: "main",
            current: 0,
            steps: [
                {
                    file: "C:\\repo\\a.js",
                    startLine: 1,
                    endLine: 1,
                    stepTitle: "A",
                    narration: "A",
                    severity: "info",
                },
            ],
            ...overrides,
        }),
    );
    return file;
}

test("startup restore refuses a live session that is not in this workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "inuse-lock" };
    try {
        writeTour(sessionA.dir, "other-session", sessionA.id);
        const { tourstore, adopted } = loadTourstore({
            session: sessionA,
            workspaceSession: null,
        });
        assert.deepEqual(tourstore.restore(), { restored: 0 });
        assert.equal(adopted.length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a foreign in-memory Tour cannot be saved by the current session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    const sessionB = { id: "session-b", dir: path.join(root, "session-b"), source: "workspace" };
    const sourceFile = writeTour(sessionA.dir, "borrowed-tour", sessionA.id);
    const loadedTour = {
        tourId: "borrowed-tour",
        title: "Older session tour",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repo: "C:\\repo",
        branch: "main",
        current: 0,
        steps: [
            {
                file: "C:\\repo\\a.js",
                startLine: 1,
                endLine: 1,
                stepTitle: "A",
                narration: "A",
                severity: "info",
            },
        ],
        sourceFile,
        sourceSessionId: sessionA.id,
    };

    try {
        const before = fs.readFileSync(sourceFile, "utf8");
        const { tourstore } = loadTourstore({
            session: sessionB,
            workspaceSession: sessionB,
            loadedTour,
        });
        const result = tourstore.save("borrowed-tour");
        assert.equal(result.ok, false);
        assert.match(result.error, /owned by another Copilot session/);
        assert.equal(
            fs.existsSync(path.join(sessionB.dir, "porthole", "tours", "borrowed-tour.json")),
            false,
        );
        assert.equal(fs.readFileSync(sourceFile, "utf8"), before);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("restore skips a legacy copied tour older than its claimed session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-b", dir: path.join(root, "session-b"), source: "workspace" };
    try {
        fs.mkdirSync(session.dir, { recursive: true });
        fs.writeFileSync(
            path.join(session.dir, "workspace.yaml"),
            "created_at: 2026-06-01T00:00:00.000Z\n",
        );
        writeTour(session.dir, "legacy-clone", session.id);
        const { tourstore, adopted } = loadTourstore({
            session,
            workspaceSession: session,
        });
        assert.deepEqual(tourstore.restore(), { restored: 0 });
        assert.equal(adopted.length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("ordinary Tour Library listing excludes sibling-session Tours", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    const sessionB = { id: "session-b", dir: path.join(root, "session-b"), source: "workspace" };
    try {
        writeTour(sessionA.dir, "current-tour", sessionA.id);
        writeTour(sessionB.dir, "other-tour", sessionB.id);
        const { tourstore } = loadTourstore({
            session: sessionA,
            workspaceSession: sessionA,
        });

        const result = tourstore.list({});

        assert.equal(result.ok, true);
        assert.deepEqual(
            result.result.tours.map((tour) => tour.tourId),
            ["current-tour"],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("activation cannot load a Tour owned by a sibling session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    const sessionB = { id: "session-b", dir: path.join(root, "session-b"), source: "workspace" };
    try {
        writeTour(sessionB.dir, "other-tour", sessionB.id);
        const { tourstore, adopted } = loadTourstore({
            session: sessionA,
            workspaceSession: sessionA,
        });

        const result = await tourstore.activateTour({ tourId: "other-tour" });

        assert.equal(result.ok, false);
        assert.match(result.error, /no tour called 'other-tour'/);
        assert.deepEqual(adopted, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("deleting a Tour leaves a sibling session's same-ID Tour untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    const sessionB = { id: "session-b", dir: path.join(root, "session-b"), source: "workspace" };
    try {
        const fileA = writeTour(sessionA.dir, "shared-tour", sessionA.id);
        const fileB = writeTour(sessionB.dir, "shared-tour", sessionB.id);
        const { tourstore } = loadTourstore({
            session: sessionA,
            workspaceSession: sessionA,
        });

        const result = tourstore.remove({ tourId: "shared-tour" });

        assert.equal(result.ok, true);
        assert.deepEqual(result.result.deleted, [fileA]);
        assert.equal(fs.existsSync(fileA), false);
        assert.equal(fs.existsSync(fileB), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("resuming the same Copilot session restores its Tour cursor without activating it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    try {
        writeTour(session.dir, "resume-tour", session.id);
        const { tourstore, adopted } = loadTourstore({
            session,
            workspaceSession: session,
        });

        assert.deepEqual(tourstore.restore(), { restored: 1 });
        assert.equal(adopted.length, 1);
        assert.equal(adopted[0].tourId, "resume-tour");
        assert.equal(adopted[0].current, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a forked Copilot session does not inherit its parent's Tour Library", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const parent = { id: "session-parent", dir: path.join(root, "session-parent") };
    const fork = { id: "session-fork", dir: path.join(root, "session-fork"), source: "workspace" };
    try {
        writeTour(parent.dir, "parent-tour", parent.id);
        fs.mkdirSync(fork.dir, { recursive: true });
        const { tourstore, adopted } = loadTourstore({
            session: fork,
            workspaceSession: fork,
        });

        assert.deepEqual(tourstore.restore(), { restored: 0 });
        assert.deepEqual(adopted, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a foreign-owned record inside the session folder is never library authority", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    try {
        const foreignFile = writeTour(session.dir, "misplaced-tour", "session-b");
        const { tourstore, adopted } = loadTourstore({
            session,
            workspaceSession: session,
        });

        assert.deepEqual(tourstore.list({}).result.tours, []);
        assert.equal((await tourstore.activateTour({ tourId: "misplaced-tour" })).ok, false);
        assert.equal(tourstore.remove({ tourId: "misplaced-tour" }).ok, false);
        assert.equal(fs.existsSync(foreignFile), true);
        assert.deepEqual(adopted, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Saved Tour Discovery reports historical Tours without loading them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    const historical = { id: "session-old", dir: path.join(root, "session-old") };
    try {
        writeTour(current.dir, "current-tour", current.id);
        writeTour(historical.dir, "auth-path", historical.id, {
            title: "Authentication path",
            repo: "C:\\repo",
            branch: "feature/auth",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
        });

        const { tourstore, adopted } = loadTourstore({
            session: current,
            workspaceSession: current,
        });

        const result = tourstore.discover({
            repo: "C:\\repo",
            sourceSessionId: historical.id,
        });

        assert.equal(result.ok, true);
        assert.deepEqual(result.result.tours.map((tour) => ({
            tourId: tour.tourId,
            title: tour.title,
            sourceSessionId: tour.sourceSessionId,
            repo: tour.repo,
            branch: tour.branch,
            createdAt: tour.createdAt,
            updatedAt: tour.updatedAt,
            staleness: tour.staleness,
        })), [{
            tourId: "auth-path",
            title: "Authentication path",
            sourceSessionId: historical.id,
            repo: "C:\\repo",
            branch: "feature/auth",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            staleness: { resolved: 1, shifted: 0, changed: 0, missing: 0 },
        }]);
        assert.deepEqual(adopted, []);
        assert.deepEqual(
            tourstore.list({}).result.tours.map((tour) => tour.tourId),
            ["current-tour"],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("import creates an independent session-owned Tour with provenance and a safe ID", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    const historical = { id: "session-old", dir: path.join(root, "session-old") };
    try {
        writeTour(current.dir, "auth-path", current.id, { title: "Current auth" });
        const sourceFile = writeTour(historical.dir, "auth-path", historical.id, {
            title: "Historical auth",
        });

        const sourceBefore = fs.readFileSync(sourceFile, "utf8");
        const { tourstore, adopted } = loadTourstore({
            session: current,
            workspaceSession: current,
        });

        const result = await tourstore.importTour({
            sourceSessionId: historical.id,
            sourceTourId: "auth-path",
            importedAt: "2026-08-21T12:00:00.000Z",
        });

        assert.equal(result.ok, true);
        assert.equal(result.result.tourId, "auth-path-2");
        const importedFile = path.join(
            current.dir,
            "porthole",
            "tours",
            "auth-path-2.json",
        );
        const imported = JSON.parse(fs.readFileSync(importedFile, "utf8"));
        assert.equal(imported.sessionId, current.id);
        assert.deepEqual(imported.provenance, {
            sourceSessionId: historical.id,
            sourceTourId: "auth-path",
            importedAt: "2026-08-21T12:00:00.000Z",
        });
        assert.equal(fs.readFileSync(sourceFile, "utf8"), sourceBefore);
        assert.equal(adopted.at(-1).tourId, "auth-path-2");
        assert.equal(adopted.at(-1).sourceFile, undefined);
        assert.equal(adopted.at(-1).sourceSessionId, current.id);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("replacing an imported Tour requires explicit confirmation and never changes the source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    const historical = { id: "session-old", dir: path.join(root, "session-old") };
    try {
        const currentFile = writeTour(current.dir, "auth-path", current.id, { title: "Current auth" });
        const sourceFile = writeTour(historical.dir, "auth-path", historical.id, { title: "Historical auth" });
        const sourceBefore = fs.readFileSync(sourceFile, "utf8");
        const currentBefore = fs.readFileSync(currentFile, "utf8");

        const cancelledStore = loadTourstore({
            session: current,
            workspaceSession: current,
            warningAnswer: undefined,
        }).tourstore;
        const cancelled = await cancelledStore.importTour({
            sourceSessionId: historical.id,
            sourceTourId: "auth-path",
            replace: true,
        });
        assert.equal(cancelled.cancelled, true);
        assert.equal(fs.readFileSync(currentFile, "utf8"), currentBefore);

        const confirmedStore = loadTourstore({
            session: current,
            workspaceSession: current,
            warningAnswer: "Replace",
        }).tourstore;
        const imported = await confirmedStore.importTour({
            sourceSessionId: historical.id,
            sourceTourId: "auth-path",
            replace: true,
            importedAt: "2026-08-21T12:00:00.000Z",
        });
        assert.equal(imported.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(currentFile, "utf8")).title, "Historical auth");
        assert.equal(fs.readFileSync(sourceFile, "utf8"), sourceBefore);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
