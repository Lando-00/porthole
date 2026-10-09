const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vscode-extension", "src");
const TOURSTORE = path.join(SRC, "tourstore.js");

function loadTourstore({
    session,
    workspaceSession,
    loadedTour = null,
    warningAnswer,
    adoptResult = true,
}) {
    const adopted = [];
    const unloaded = [];
    const warnings = [];
    let persistenceHandlers = null;
    const loadedTours = new Map(loadedTour ? [[loadedTour.tourId, loadedTour]] : []);
    const tour = {
        setPersistenceHandlers(handlers) {
            persistenceHandlers = handlers;
        },
        getTour: (tourId) => loadedTours.get(tourId) || null,
        getLibrary: () => ({ tours: [...loadedTours.values()], activeTourId: null }),
        updateRevisionStates(updates) {
            for (const update of updates) {
                const entry = loadedTours.get(update.tourId);
                if (entry) entry.revisionState = update.revisionState;
            }
        },
        has: (tourId) => loadedTours.has(tourId),
        adopt(entry) {
            if (!adoptResult) return false;
            adopted.push(entry);
            loadedTours.set(entry.tourId, entry);
            return true;
        },
        async activateTour() {
            return { ok: true, result: {} };
        },
        unload(tourId) {
            unloaded.push(tourId);
            return loadedTours.delete(tourId);
        },
    };
    const mocks = new Map([
        [
            "vscode",
            {
                commands: { registerCommand: () => ({ dispose() {} }) },
                window: {
                    showWarningMessage: async (message, options, ...actions) => {
                        warnings.push({ message, options, actions });
                        return warningAnswer;
                    },
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
                gitRevisions: async (repos) =>
                    new Map(repos.map((repo) => [repo, { repo, branch: "main", commit: "abc" }])),
                revisionState: (publication, revision) =>
                    publication?.commit && revision?.commit === publication.commit
                        ? "same-revision"
                        : publication?.commit && revision?.commit
                          ? "revision-changed"
                          : "unknown",
                normaliseRepo: (repo) => repo || null,
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
    return {
        tourstore,
        adopted,
        unloaded,
        warnings,
        getPersistenceHandlers: () => persistenceHandlers,
    };
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

function writeProgress(sessionDir, tourId, publicationId, current) {
    const file = path.join(sessionDir, "porthole", "tour-progress", `${tourId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify({
            schema: 1,
            publicationId,
            current,
            updatedAt: "2026-08-21T12:00:00.000Z",
        }),
        "utf8",
    );
    return file;
}

test("startup restore refuses a live session that is not in this workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "inuse-lock" };
    try {
        writeTour(sessionA.dir, "other-session", sessionA.id);
        const { tourstore, adopted } = loadTourstore({
            session: sessionA,
            workspaceSession: null,
        });
        assert.deepEqual(await tourstore.restore(), { restored: 0 });
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
        const result = tourstore.publish({
            ...loadedTour,
            publication: {
                id: "publication-a",
                at: "2026-01-01T00:00:00.000Z",
                repo: "C:\\repo",
                commit: null,
            },
            steps: loadedTour.steps.map((step) => ({
                ...step,
                anchor: { sha256: "original-anchor" },
            })),
        });
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

test("restore skips a legacy copied tour older than its claimed session", async () => {
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
        assert.deepEqual(await tourstore.restore(), { restored: 0 });
        assert.equal(adopted.length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("ordinary Tour Library listing excludes sibling-session Tours", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const sessionA = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    const sessionB = { id: "session-b", dir: path.join(root, "session-b"), source: "workspace" };
    try {
        writeTour(sessionA.dir, "current-tour", sessionA.id, {
            publication: {
                id: "publication-list",
                at: "2026-01-01T00:00:00.000Z",
                repo: "C:\\repo",
                commit: "abc",
            },
        });
        writeTour(sessionB.dir, "other-tour", sessionB.id);
        const { tourstore } = loadTourstore({
            session: sessionA,
            workspaceSession: sessionA,
        });

        const result = await tourstore.list({});

        assert.equal(result.ok, true);
        assert.deepEqual(
            result.result.tours.map((tour) => tour.tourId),
            ["current-tour"],
        );
        assert.equal(result.result.tours[0].revisionState, "same-revision");
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
        const progressA = writeProgress(
            sessionA.dir,
            "shared-tour",
            "legacy-progress",
            0,
        );
        const { tourstore } = loadTourstore({
            session: sessionA,
            workspaceSession: sessionA,
        });

        const result = tourstore.remove({ tourId: "shared-tour" });

        assert.equal(result.ok, true);
        assert.deepEqual(result.result.deleted, [fileA]);
        assert.equal(fs.existsSync(fileA), false);
        assert.equal(fs.existsSync(progressA), false);
        assert.equal(fs.existsSync(fileB), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("resuming the same Copilot session restores its Tour cursor without activating it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    try {
        writeTour(session.dir, "resume-tour", session.id, {
            current: -1,
            publication: {
                id: "publication-resume",
                at: "2026-01-01T00:00:00.000Z",
                repo: "C:\\repo",
                commit: "abc",
            },
        });
        writeProgress(session.dir, "resume-tour", "publication-resume", 0);
        const { tourstore, adopted } = loadTourstore({
            session,
            workspaceSession: session,
        });

        assert.deepEqual(await tourstore.restore(), { restored: 1 });
        assert.equal(adopted.length, 1);
        assert.equal(adopted[0].tourId, "resume-tour");
        assert.equal(adopted[0].current, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("progress from an older publication cannot move a refreshed Tour", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-a", dir: path.join(root, "session-a"), source: "workspace" };
    try {
        writeTour(session.dir, "refreshed-tour", session.id, {
            current: -1,
            publication: {
                id: "publication-new",
                at: "2026-08-21T12:00:00.000Z",
                repo: "C:\\repo",
                commit: "abc",
            },
        });
        writeProgress(session.dir, "refreshed-tour", "publication-old", 0);
        const { tourstore, adopted } = loadTourstore({
            session,
            workspaceSession: session,
        });

        assert.deepEqual(await tourstore.restore(), { restored: 1 });
        assert.equal(adopted[0].current, -1);
        assert.equal(adopted[0].publicationId, "publication-new");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a forked Copilot session does not inherit its parent's Tour Library", async () => {
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

        assert.deepEqual(await tourstore.restore(), { restored: 0 });
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

        assert.deepEqual((await tourstore.list({})).result.tours, []);
        assert.equal((await tourstore.activateTour({ tourId: "misplaced-tour" })).ok, false);
        assert.equal(tourstore.remove({ tourId: "misplaced-tour" }).ok, false);
        assert.equal(fs.existsSync(foreignFile), true);
        assert.deepEqual(adopted, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Saved Tour Discovery reports historical Tours without loading them", async () => {
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
            (await tourstore.list({})).result.tours.map((tour) => tour.tourId),
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
        const publication = {
            id: "publication-source",
            at: "2026-01-01T00:00:00.000Z",
            repo: "C:\\repo",
            commit: "a".repeat(40),
        };
        const sourceFile = writeTour(historical.dir, "auth-path", historical.id, {
            title: "Historical auth",
            commit: publication.commit,
            publication,
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
        assert.deepEqual(imported.publication, publication);
        assert.equal(imported.commit, publication.commit);
        assert.equal(fs.readFileSync(sourceFile, "utf8"), sourceBefore);
        assert.equal(adopted.at(-1).tourId, "auth-path-2");
        assert.equal(adopted.at(-1).sourceFile, undefined);
        assert.equal(adopted.at(-1).sourceSessionId, current.id);
        const canonicalBeforeProgress = fs.readFileSync(importedFile, "utf8");
        adopted.at(-1).current = 0;
        assert.equal(tourstore.saveProgress("auth-path-2").ok, true);
        assert.equal(fs.readFileSync(importedFile, "utf8"), canonicalBeforeProgress);
        const progress = JSON.parse(
            fs.readFileSync(
                path.join(
                    current.dir,
                    "porthole",
                    "tour-progress",
                    "auth-path-2.json",
                ),
                "utf8",
            ),
        );
        assert.equal(progress.schema, 1);
        assert.equal(progress.publicationId, adopted.at(-1).publicationId);
        assert.equal(progress.current, 0);
        assert.match(progress.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(importedFile, "utf8")).provenance,
            imported.provenance,
        );
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

test("Archive Tour is durable, hidden by default, and reversible", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    try {
        const publication = {
            id: "publication-archive",
            at: "2026-08-21T12:00:00.000Z",
            repo: "C:\\repo",
            commit: "abc",
        };
        const file = writeTour(session.dir, "auth-path", session.id, {
            current: -1,
            publication,
        });
        writeProgress(session.dir, "auth-path", publication.id, 0);
        const { tourstore, unloaded, adopted } = loadTourstore({
            session,
            workspaceSession: session,
        });

        const archived = await tourstore.setArchived({
            tourId: "auth-path",
            archived: true,
            archivedAt: "2026-08-21T13:00:00.000Z",
        });
        assert.equal(archived.ok, true);
        assert.deepEqual(unloaded, ["auth-path"]);
        assert.deepEqual((await tourstore.list({})).result.tours, []);
        assert.deepEqual(
            (await tourstore.list({ includeArchived: true })).result.tours.map((tour) => ({
                tourId: tour.tourId,
                archivedAt: tour.archivedAt,
            })),
            [{ tourId: "auth-path", archivedAt: "2026-08-21T13:00:00.000Z" }],
        );
        assert.equal(fs.existsSync(file), true);
        const archivedRecord = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(archivedRecord.current, -1);
        assert.deepEqual(archivedRecord.publication, publication);
        assert.deepEqual(await tourstore.restore(), { restored: 0 });

        const unarchived = await tourstore.setArchived({
            tourId: "auth-path",
            archived: false,
        });
        assert.equal(unarchived.ok, true);
        assert.equal(adopted.at(-1).tourId, "auth-path");
        assert.deepEqual(
            (await tourstore.list({})).result.tours.map((tour) => tour.tourId),
            ["auth-path"],
        );
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).archivedAt, undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("archiving a Tour cannot change a sibling session's same-ID Tour", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    const sibling = { id: "session-sibling", dir: path.join(root, "session-sibling") };
    try {
        const currentFile = writeTour(current.dir, "shared-tour", current.id);
        const siblingFile = writeTour(sibling.dir, "shared-tour", sibling.id);
        const siblingBefore = fs.readFileSync(siblingFile, "utf8");
        const { tourstore } = loadTourstore({
            session: current,
            workspaceSession: current,
        });

        assert.equal(
            (await tourstore.setArchived({ tourId: "shared-tour", archived: true })).ok,
            true,
        );
        assert.equal(Boolean(JSON.parse(fs.readFileSync(currentFile, "utf8")).archivedAt), true);
        assert.equal(fs.readFileSync(siblingFile, "utf8"), siblingBefore);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("unarchive rolls back when the Tour cannot return to the in-memory library", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    try {
        const file = writeTour(session.dir, "auth-path", session.id, {
            archivedAt: "2026-08-21T13:00:00.000Z",
        });
        const { tourstore } = loadTourstore({
            session,
            workspaceSession: session,
            adoptResult: false,
        });

        const result = await tourstore.setArchived({ tourId: "auth-path", archived: false });

        assert.equal(result.ok, false);
        assert.match(result.error, /library is full/);
        assert.equal(
            JSON.parse(fs.readFileSync(file, "utf8")).archivedAt,
            "2026-08-21T13:00:00.000Z",
        );
        assert.deepEqual((await tourstore.list({})).result.tours, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Saved Tour Discovery classifies provable legacy copies and preserves uncertain records", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    try {
        fs.mkdirSync(session.dir, { recursive: true });
        fs.writeFileSync(
            path.join(session.dir, "workspace.yaml"),
            "created_at: 2026-06-01T00:00:00.000Z\n",
            "utf8",
        );
        writeTour(session.dir, "legacy-copy", session.id, {
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        writeTour(session.dir, "uncertain-copy", session.id, {
            createdAt: "not-a-date",
        });
        writeTour(session.dir, "current-tour", session.id, {
            createdAt: "2026-07-01T00:00:00.000Z",
        });
        const { tourstore } = loadTourstore({
            session,
            workspaceSession: session,
        });

        const first = tourstore.discover({ includeLegacyCurrent: true });
        const second = tourstore.discover({ includeLegacyCurrent: true });

        assert.deepEqual(first, second);
        assert.deepEqual(
            first.result.tours.map((tour) => ({
                tourId: tour.tourId,
                legacyStatus: tour.legacyStatus,
                legacyEvidence: tour.legacyEvidence,
            })),
            [
                {
                    tourId: "legacy-copy",
                    legacyStatus: "legacy-copy",
                    legacyEvidence: {
                        reason: "record predates the Copilot session that claims it",
                        recordCreatedAt: "2026-01-01T00:00:00.000Z",
                        claimedSessionCreatedAt: "2026-06-01T00:00:00.000Z",
                    },
                },
                {
                    tourId: "uncertain-copy",
                    legacyStatus: "uncertain",
                    legacyEvidence: {
                        reason: "record creation time is missing or invalid",
                        recordCreatedAt: "not-a-date",
                        claimedSessionCreatedAt: "2026-06-01T00:00:00.000Z",
                    },
                },
            ],
        );
        assert.equal(fs.existsSync(path.join(session.dir, "porthole", "tours", "legacy-copy.json")), true);
        assert.equal(fs.existsSync(path.join(session.dir, "porthole", "tours", "uncertain-copy.json")), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a provable legacy copy can be imported with its evidence into the current session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    try {
        fs.mkdirSync(session.dir, { recursive: true });
        fs.writeFileSync(
            path.join(session.dir, "workspace.yaml"),
            "created_at: 2026-06-01T00:00:00.000Z\n",
            "utf8",
        );
        const sourceFile = writeTour(session.dir, "legacy-copy", session.id, {
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const sourceBefore = fs.readFileSync(sourceFile, "utf8");
        const { tourstore } = loadTourstore({
            session,
            workspaceSession: session,
        });

        const result = await tourstore.importTour({
            sourceSessionId: session.id,
            sourceTourId: "legacy-copy",
            importedAt: "2026-08-21T14:00:00.000Z",
        });

        assert.equal(result.ok, true);
        assert.equal(result.result.tourId, "legacy-copy-2");
        assert.deepEqual(result.result.provenance, {
            sourceSessionId: session.id,
            sourceTourId: "legacy-copy",
            importedAt: "2026-08-21T14:00:00.000Z",
            legacyEvidence: {
                reason: "record predates the Copilot session that claims it",
                recordCreatedAt: "2026-01-01T00:00:00.000Z",
                claimedSessionCreatedAt: "2026-06-01T00:00:00.000Z",
            },
        });
        assert.equal(fs.readFileSync(sourceFile, "utf8"), sourceBefore);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("legacy cleanup confirms and deletes only one provable stored copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    const sibling = { id: "session-sibling", dir: path.join(root, "session-sibling") };
    try {
        for (const session of [current, sibling]) {
            fs.mkdirSync(session.dir, { recursive: true });
            fs.writeFileSync(
                path.join(session.dir, "workspace.yaml"),
                "created_at: 2026-06-01T00:00:00.000Z\n",
                "utf8",
            );
        }
        const legacyFile = writeTour(current.dir, "shared-tour", current.id, {
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const siblingFile = writeTour(sibling.dir, "shared-tour", sibling.id, {
            createdAt: "2026-07-01T00:00:00.000Z",
        });
        const siblingBefore = fs.readFileSync(siblingFile, "utf8");

        const cancelledStore = loadTourstore({
            session: current,
            workspaceSession: current,
            warningAnswer: undefined,
        }).tourstore;
        assert.equal((await cancelledStore.cleanupLegacy({
            sourceSessionId: current.id,
            sourceTourId: "shared-tour",
        })).cancelled, true);
        assert.equal(fs.existsSync(legacyFile), true);

        const confirmed = loadTourstore({
            session: current,
            workspaceSession: current,
            warningAnswer: "Delete legacy copy",
        });
        const result = await confirmed.tourstore.cleanupLegacy({
            sourceSessionId: current.id,
            sourceTourId: "shared-tour",
        });

        assert.equal(result.ok, true);
        assert.equal(result.result.deleted, legacyFile);
        assert.equal(fs.existsSync(legacyFile), false);
        assert.equal(fs.readFileSync(siblingFile, "utf8"), siblingBefore);
        assert.match(confirmed.warnings[0].message, /shared-tour/);
        assert.match(confirmed.warnings[0].options.detail, /predates/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("legacy cleanup refuses uncertain records without prompting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-session-"));
    const session = { id: "session-current", dir: path.join(root, "session-current"), source: "workspace" };
    try {
        fs.mkdirSync(session.dir, { recursive: true });
        fs.writeFileSync(
            path.join(session.dir, "workspace.yaml"),
            "created_at: 2026-06-01T00:00:00.000Z\n",
            "utf8",
        );
        const file = writeTour(session.dir, "uncertain-copy", session.id, {
            createdAt: "not-a-date",
        });
        const loaded = loadTourstore({
            session,
            workspaceSession: session,
            warningAnswer: "Delete legacy copy",
        });

        const result = await loaded.tourstore.cleanupLegacy({
            sourceSessionId: session.id,
            sourceTourId: "uncertain-copy",
        });

        assert.equal(result.ok, false);
        assert.match(result.error, /uncertain/);
        assert.equal(fs.existsSync(file), true);
        assert.deepEqual(loaded.warnings, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
