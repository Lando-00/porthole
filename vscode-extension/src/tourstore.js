// Tours that outlive the window.
//
// A walkthrough of a pull request is worth more than one sitting, and the
// session folder is the natural place to keep one: it is already the shared
// ground between the CLI and the editor, it is already where reviews live, and
// a later session can find it.
//
//   <sessionDir>/porthole/tours/<tourId>.json
//
// Saving is automatic. The alternative - a save step the model has to remember
// - is a step the model will sometimes not take, and losing an explanation you
// have already walked is exactly the failure this feature exists to prevent.
//
// Loading re-anchors every step, so a tour written three commits ago says so
// rather than pointing confidently at whatever now occupies line 40.

const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { diag } = require("./log");
const anchors = require("./anchors");
const tour = require("./tour");
const { findSession, sessionRoot } = require("./session");
const { projectFolder, gitHead, storedPath, absoluteFile } = require("./repo");

const SCHEMA = 1;
const SLUG_PATTERN = /^[\w-]{1,64}$/;

/**
 * How long to sit on a change before writing.
 *
 * Every step of a walkthrough moves the cursor, and a synchronous write per
 * step turns arrowing through a tour into a stream of disk writes. Nothing is
 * lost by waiting: a flush is forced on deactivation.
 */
const SAVE_DEBOUNCE_MS = 750;

const pending = new Map();

// --- paths ------------------------------------------------------------------

function toursDir(sessionDir) {
    return path.join(sessionDir, "porthole", "tours");
}

function fileFor(sessionDir, tourId) {
    return path.join(toursDir(sessionDir), `${tourId}.json`);
}

// --- saving -----------------------------------------------------------------

/**
 * Queues a save.
 *
 * Called from tour.js on every state change, including cursor moves, so it has
 * to be cheap. The actual write happens on the timer.
 */
function schedule(tourId) {
    if (!tourId) return;
    const existing = pending.get(tourId);
    if (existing) clearTimeout(existing);
    pending.set(
        tourId,
        setTimeout(() => {
            pending.delete(tourId);
            save(tourId);
        }, SAVE_DEBOUNCE_MS),
    );
}

/** Writes any queued saves immediately. Used on shutdown. */
function flush() {
    for (const [tourId, timer] of pending) {
        clearTimeout(timer);
        save(tourId);
    }
    pending.clear();
}

function save(tourId) {
    const entry = tour.getTour(tourId);
    if (!entry) return { ok: false, error: `no tour called '${tourId}' is loaded` };

    const session = findSession();
    if (!session) {
        // Not an error worth surfacing: a window with no session simply has
        // nowhere to put it, and the tour still works in memory.
        diag(`tour not saved (no session folder): ${tourId}`);
        return { ok: false, error: "no Copilot session folder found for this window" };
    }

    const repo = entry.repo || projectFolder();
    const head = repo ? gitHead(repo) : { branch: null, commit: null };

    const record = {
        schema: SCHEMA,
        tourId,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: new Date().toISOString(),
        sessionId: session.id,
        endpointId: entry.endpointId || null,
        repo,
        branch: entry.branch ?? head.branch,
        commit: entry.commit ?? head.commit,
        current: entry.current,
        steps: entry.steps.map((s) => ({
            file: storedPath(s.file, repo),
            startLine: s.startLine,
            endLine: s.endLine,
            stepTitle: s.stepTitle,
            narration: s.narration,
            // As authored, never the severity a stale step is *shown* with.
            // Writing the display value back would destroy the caller's choice
            // after a single round trip.
            severity: s.severity,
            // Reused, not recomputed, when the step already has one.
            //
            // Recomputing looked harmless and was the worst bug in this
            // feature: a step whose code had changed falls back to its stored
            // range, so re-hashing would take whatever unrelated code now sits
            // there and store it as what the narration was written about. The
            // next load would call the tour current, the warnings would vanish,
            // and one arrow-key press would have laundered a three-commit-old
            // walkthrough into a trustworthy-looking one.
            anchor: s.anchor || anchors.anchorFor(s.file, s.startLine, s.endLine) || undefined,
        })),
    };

    const file = fileFor(session.dir, tourId);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Write then rename, so a reader never sees a half-written tour.
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (err) {
        diag(`tour save failed: ${tourId}: ${err.message}`);
        return { ok: false, error: `could not write the tour: ${err.message}` };
    }

    diag(`tour saved: ${file} (${record.steps.length} steps)`);
    return { ok: true, result: { tourId, file, steps: record.steps.length } };
}

// --- reading ----------------------------------------------------------------

function read(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || parsed.schema !== SCHEMA || !SLUG_PATTERN.test(String(parsed.tourId || ""))) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Every saved tour on this machine, newest first.
 *
 * Scans sibling session folders, not just this one, for the same reason reviews
 * do: yesterday's walkthrough of a pull request is the one you want today, and
 * it was written by a session that has since ended.
 */
function scan({ repo, sessionId } = {}) {
    const root = sessionRoot();
    const wantRepo = repo ? String(repo).toLowerCase() : null;

    let sessions = [];
    try {
        sessions = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }

    const found = [];
    for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        if (sessionId && entry.name !== sessionId) continue;

        const dir = toursDir(path.join(root, entry.name));
        let files = [];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        } catch {
            continue;
        }
        for (const name of files) {
            const file = path.join(dir, name);
            const record = read(file);
            if (!record) continue;
            if (wantRepo && String(record.repo || "").toLowerCase() !== wantRepo) continue;
            found.push({ ...record, file });
        }
    }

    found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return found;
}

/**
 * Re-points a saved tour at the code as it is now.
 *
 * Returns the resolved steps and a tally, so a caller can say "four of these
 * nine steps no longer describe anything" instead of walking someone through
 * code that has moved on.
 *
 * A step whose file is not here is **kept**, not dropped. Absence is usually
 * temporary - a different branch, an uninitialised submodule, a checkout that
 * has moved - and dropping it would be permanent, because the next autosave
 * writes the shortened tour back over the original. `upsert` already refuses to
 * lose a step quietly; the load path has to hold the same line.
 */
function resolveSteps(record) {
    const tally = anchors.tally();
    const steps = [];

    for (const step of record.steps || []) {
        const absolute = absoluteFile(step.file, record.repo);
        const state = anchors.resolve(step, absolute);
        tally[state.status] += 1;

        steps.push({
            ...step,
            file: absolute,
            startLine: state.startLine,
            endLine: state.endLine,
            status: state.status,
        });
    }

    return { steps, staleness: tally };
}

// --- routes -----------------------------------------------------------------

/**
 * The library, as the CLI sees it: what is loaded, what is only on disk, and
 * how much of each still describes the current code.
 */
function list(payload = {}) {
    const limit = Math.min(200, Math.max(1, Number.parseInt(payload.limit, 10) || 50));
    const includeSteps = payload.includeSteps === true;
    const loaded = tour.getLibrary();
    const byId = new Map();

    for (const entry of loaded.tours) {
        byId.set(entry.tourId, {
            tourId: entry.tourId,
            title: entry.title,
            steps: entry.steps.length,
            current: entry.current,
            loaded: true,
            active: entry.tourId === loaded.activeTourId,
            repo: entry.repo,
            branch: entry.branch,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            // Present only for a tour that came off disk, and describing how it
            // resolved when it was read. A tour built in this window is current
            // by definition; a tally of zeros for it would read as "checked and
            // fine" rather than "not applicable".
            staleness: entry.staleness,
            stepDetail: includeSteps ? entry.steps.map(describeStep) : undefined,
        });
    }

    for (const record of scan({ repo: payload.repo })) {
        if (byId.has(record.tourId)) {
            // Loaded wins, but the on-disk copy is where staleness can be
            // measured without disturbing what is on screen.
            const summary = byId.get(record.tourId);
            summary.file = record.file;
            summary.sessionId = record.sessionId;
            continue;
        }
        const { steps, staleness } = resolveSteps(record);
        byId.set(record.tourId, {
            tourId: record.tourId,
            title: record.title,
            steps: (record.steps || []).length,
            current: record.current,
            loaded: false,
            active: false,
            repo: record.repo,
            branch: record.branch,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            sessionId: record.sessionId,
            file: record.file,
            staleness,
            stepDetail: includeSteps ? steps.map(describeStep) : undefined,
        });
    }

    const tours = [...byId.values()].slice(0, limit);
    return { ok: true, result: { tours, activeTourId: loaded.activeTourId, loaded: loaded.tours.length } };
}

function describeStep(step) {
    return {
        stepTitle: step.stepTitle,
        file: step.file,
        startLine: step.startLine,
        endLine: step.endLine,
        severity: step.severity,
        status: step.status,
    };
}

/**
 * Switches to a tour, loading it from disk first if it is not in memory.
 *
 * The load path is what makes "pick up yesterday's review" work, and it is also
 * where the anchors earn their keep.
 */
async function activateTour(payload = {}) {
    const tourId = String(payload.tourId || "").trim();
    if (!SLUG_PATTERN.test(tourId)) return { ok: false, error: "a tourId is required" };

    if (!tour.has(tourId)) {
        const loaded = loadFromDisk(tourId);
        if (!loaded.ok) return loaded;
    }

    const result = await tour.activateTour(tourId, payload.step);
    if (!result.ok) return result;

    const entry = tour.getTour(tourId);
    return {
        ok: true,
        result: { ...result.result, ...(entry?.staleness ? { staleness: entry.staleness } : {}) },
    };
}

function loadFromDisk(tourId) {
    const record = scan().find((r) => r.tourId === tourId);
    if (!record) return { ok: false, error: `no tour called '${tourId}' was found` };

    const { steps, staleness } = resolveSteps(record);
    if (steps.length === 0 || steps.every((s) => s.status === "missing")) {
        return {
            ok: false,
            error: "none of that tour's files are in this checkout",
            result: { tourId, staleness },
        };
    }

    const adopted = tour.adopt({
        tourId: record.tourId,
        title: record.title,
        steps,
        // Where the walk left off, so activating a tour resumes it rather than
        // starting over.
        current: record.current,
        endpointId: record.endpointId,
        repo: record.repo,
        branch: record.branch,
        commit: record.commit,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        staleness,
    });
    if (!adopted) return { ok: false, error: "the tour library is full; close a tour first" };

    diag(`tour loaded from disk: ${tourId} ${JSON.stringify(staleness)}`);
    return { ok: true, result: { tourId, steps: steps.length, staleness } };
}

/** Unloads a tour and deletes its file. */
function remove(payload = {}) {
    const tourId = String(payload.tourId || "").trim();
    if (!SLUG_PATTERN.test(tourId)) return { ok: false, error: "a tourId is required" };

    const unloaded = tour.unload(tourId);

    const timer = pending.get(tourId);
    if (timer) {
        // Otherwise a queued save would write the file back out moments after
        // it was deleted.
        clearTimeout(timer);
        pending.delete(tourId);
    }

    const deleted = [];
    for (const record of scan()) {
        if (record.tourId !== tourId) continue;
        try {
            fs.rmSync(record.file, { force: true });
            deleted.push(record.file);
        } catch (err) {
            diag(`tour delete failed: ${record.file}: ${err.message}`);
        }
    }

    if (!unloaded && deleted.length === 0) {
        return { ok: false, error: `no tour called '${tourId}' was found` };
    }

    diag(`tour deleted: ${tourId} (unloaded=${unloaded}, files=${deleted.length})`);
    return { ok: true, result: { tourId, unloaded, deleted } };
}

// --- lifecycle --------------------------------------------------------------

/**
 * Brings this session's saved tours back, without starting one.
 *
 * Deliberately this session only, and deliberately none activated: reopening a
 * window should show you what you had, not decide what you are looking at.
 */
function restore() {
    const session = findSession();
    if (!session) return { restored: 0 };

    let restored = 0;
    for (const record of scan({ sessionId: session.id })) {
        if (tour.has(record.tourId)) continue;
        const { steps, staleness } = resolveSteps(record);
        if (steps.length === 0) continue;
        if (
            tour.adopt({
                tourId: record.tourId,
                title: record.title,
                steps,
                // Restored, so activating later resumes the walk. Restoring is
                // not activating - the window shows you what you had, it does
                // not decide what you are looking at.
                current: record.current,
                endpointId: record.endpointId,
                repo: record.repo,
                branch: record.branch,
                commit: record.commit,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                // Carried through, so a restored tour can still admit it is out
                // of date. This is the case where staleness matters most, and
                // it was the one case that reported nothing.
                staleness,
            })
        ) {
            restored += 1;
        }
    }

    if (restored) diag(`restored ${restored} tour(s) from this session`);
    return { restored };
}

function activateExtension(context) {
    tour.setPersistHandler(schedule);
    context.subscriptions.push({ dispose: flush });

    context.subscriptions.push(
        // Deleting lives here rather than in tour.js because it is the only
        // tour operation that touches the disk.
        vscode.commands.registerCommand("porthole.tour.delete", async (arg) => {
            const tourId = idOf(arg);
            if (!tourId) return;

            const entry = tour.getTour(tourId);
            const name = entry ? entry.title : tourId;
            const confirmed = await vscode.window.showWarningMessage(
                `Delete the tour "${name}"?`,
                { modal: true, detail: "This removes it from the library and from disk." },
                "Delete",
            );
            if (confirmed !== "Delete") return;

            const result = remove({ tourId });
            vscode.window.showInformationMessage(
                result.ok ? `porthole: deleted '${tourId}'.` : `porthole: ${result.error}`,
            );
        }),
    );

    // Deferred: findSession reads the workspace folders, which are not settled
    // at the instant activation runs.
    setTimeout(() => {
        try {
            restore();
        } catch (err) {
            diag(`tour restore failed: ${err.message}`);
        }
    }, 1500);
}

/** A tour id, from either a bare string or the tree node the menu passes. */
function idOf(arg) {
    if (typeof arg === "string") return arg;
    const id = arg && typeof arg.id === "string" ? arg.id : "";
    return id.startsWith("tour-") ? id.slice("tour-".length) : "";
}

module.exports = {
    // lifecycle
    activate: activateExtension,
    // routes
    list,
    activateTour,
    remove,
    // internals, exported for the doctor and for probes
    save,
    flush,
    restore,
    scan,
    resolveSteps,
    toursDir,
};
