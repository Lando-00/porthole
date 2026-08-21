const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vscode-extension", "src");
const TOURSTORE = path.join(SRC, "tourstore.js");

function loadTourstore({ session, workspaceSession, loadedTour = null }) {
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
                    showWarningMessage: async () => undefined,
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

function writeTour(sessionDir, tourId, sessionId) {
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

test("a tour loaded from another session is not copied into the current session", () => {
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
        const { tourstore } = loadTourstore({
            session: sessionB,
            workspaceSession: sessionB,
            loadedTour,
        });
        const result = tourstore.save("borrowed-tour");
        assert.equal(result.ok, true);
        assert.equal(
            fs.existsSync(path.join(sessionB.dir, "porthole", "tours", "borrowed-tour.json")),
            false,
        );
        assert.equal(JSON.parse(fs.readFileSync(sourceFile, "utf8")).sessionId, sessionA.id);
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
