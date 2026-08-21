const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vscode-extension", "src");
const REVIEWS = path.join(SRC, "reviews.js");

function writeReview(session, slug, overrides = {}) {
    const file = path.join(session.dir, "porthole", "reviews", `${slug}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        schema: 1,
        slug,
        title: slug,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        sessionId: session.id,
        repo: "C:\\repo",
        branch: "main",
        findings: [{
            file: "C:\\repo\\a.js",
            startLine: 1,
            endLine: 1,
            severity: "info",
            message: "Finding",
        }],
        ...overrides,
    }), "utf8");
    return file;
}

function loadReviews({ session, warningAnswer } = {}) {
    const annotationsApplied = [];
    const warnings = [];
    const mocks = new Map([
        ["vscode", {
            commands: { registerCommand: () => ({ dispose() {} }) },
            window: {
                showWarningMessage: async (message, options, ...actions) => {
                    warnings.push({ message, options, actions });
                    return warningAnswer;
                },
                showInformationMessage() {},
            },
        }],
        [path.join(SRC, "session.js"), {
            findSession: () => session,
            findWorkspaceSession: () => session,
            sessionRoot: () => path.dirname(session.dir),
        }],
        [path.join(SRC, "annotations.js"), {
            getState: () => ({ entries: [], title: null }),
            annotate: async (payload) => annotationsApplied.push(payload),
        }],
        [path.join(SRC, "tour.js"), {
            getState: () => ({ title: null, steps: [] }),
        }],
        [path.join(SRC, "anchors.js"), {
            tally: () => ({ resolved: 0, shifted: 0, changed: 0, missing: 0 }),
            resolve: (finding) => ({
                status: "resolved",
                startLine: finding.startLine,
                endLine: finding.endLine,
            }),
            anchorFor: () => ({ sha256: "anchor" }),
        }],
        [path.join(SRC, "repo.js"), {
            projectFolder: () => "C:\\repo",
            gitHead: () => ({ branch: "main", commit: "abc" }),
            isInside: (parent, child) => child.startsWith(parent),
            storedPath: (file) => file,
            absoluteFile: (file) => file,
            normaliseSlug: (value) => String(value).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        }],
        [path.join(SRC, "log.js"), { diag() {} }],
    ]);
    const originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
        if (mocks.has(request)) return mocks.get(request);
        let resolved;
        try { resolved = Module._resolveFilename(request, parent, isMain); } catch { resolved = null; }
        if (resolved && mocks.has(resolved)) return mocks.get(resolved);
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[REVIEWS];
    let reviews;
    try { reviews = require(REVIEWS); } finally { Module._load = originalLoad; }
    return { reviews, annotationsApplied, warnings };
}

test("ordinary Saved Review listing and loading exclude sibling sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-review-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current") };
    const sibling = { id: "session-sibling", dir: path.join(root, "session-sibling") };
    try {
        writeReview(current, "current-review");
        writeReview(sibling, "sibling-review");
        const loaded = loadReviews({ session: current });

        assert.deepEqual(
            loaded.reviews.list({}).result.reviews.map((review) => review.slug),
            ["current-review"],
        );
        assert.equal((await loaded.reviews.load({ slug: "sibling-review" })).ok, false);
        assert.deepEqual(loaded.annotationsApplied, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Saved Review Discovery and import create an independent provenance copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-review-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current") };
    const sibling = { id: "session-sibling", dir: path.join(root, "session-sibling") };
    try {
        writeReview(current, "auth-review", { title: "Current review" });
        const sourceFile = writeReview(sibling, "auth-review", {
            title: "Historical review",
            branch: "feature/auth",
        });

        const sourceBefore = fs.readFileSync(sourceFile, "utf8");
        const loaded = loadReviews({ session: current });

        const discovered = loaded.reviews.discover({ repo: "C:\\repo" });
        assert.deepEqual(discovered.result.reviews.map((review) => ({
            slug: review.slug,
            sourceSessionId: review.sourceSessionId,
            branch: review.branch,
            createdAt: review.createdAt,
            updatedAt: review.updatedAt,
            findings: review.findings,
        })), [{
            slug: "auth-review",
            sourceSessionId: sibling.id,
            branch: "feature/auth",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            findings: 1,
        }]);

        const imported = await loaded.reviews.importReview({
            sourceSessionId: sibling.id,
            sourceSlug: "auth-review",
            importedAt: "2026-08-21T14:00:00.000Z",
        });
        assert.equal(imported.result.slug, "auth-review-2");
        const importedFile = path.join(current.dir, "porthole", "reviews", "auth-review-2.json");
        const record = JSON.parse(fs.readFileSync(importedFile, "utf8"));
        assert.equal(record.sessionId, current.id);
        assert.deepEqual(record.provenance, {
            sourceSessionId: sibling.id,
            sourceSlug: "auth-review",
            importedAt: "2026-08-21T14:00:00.000Z",
        });
        assert.equal(fs.readFileSync(sourceFile, "utf8"), sourceBefore);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("deleting a Saved Review is confirmed and scoped to the current session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-review-session-"));
    const current = { id: "session-current", dir: path.join(root, "session-current") };
    const sibling = { id: "session-sibling", dir: path.join(root, "session-sibling") };
    try {
        const currentFile = writeReview(current, "shared-review");
        const siblingFile = writeReview(sibling, "shared-review");
        const siblingBefore = fs.readFileSync(siblingFile, "utf8");
        const loaded = loadReviews({ session: current, warningAnswer: "Delete review" });

        const result = await loaded.reviews.deleteReview({ slug: "shared-review" });

        assert.equal(result.ok, true);
        assert.equal(result.result.deleted, currentFile);
        assert.equal(fs.existsSync(currentFile), false);
        assert.equal(fs.readFileSync(siblingFile, "utf8"), siblingBefore);
        assert.match(loaded.warnings[0].message, /shared-review/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
