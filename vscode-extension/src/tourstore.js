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
const { findWorkspaceSession, sessionRoot } = require("./session");
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

/**
 * Backoff for the startup tour restore, in milliseconds between attempts.
 *
 * Covers the same window the old flat 1500ms wait did, but without charging it
 * to the overwhelmingly common case where the workspace folders are already
 * there when the extension host activates.
 */
const RESTORE_RETRY_MS = [150, 350, 1000, 2000];

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

    const session = findWorkspaceSession();
    if (!session) {
        diag(`tour not saved (no exact workspace session): ${tourId}`);
        return { ok: false, error: "no Copilot session folder is bound to this window" };
    }
    if (entry.sourceSessionId && entry.sourceSessionId !== session.id) {
        return {
            ok: false,
            error: `tour '${tourId}' is owned by another Copilot session`,
        };
    }

    const repo = entry.repo || projectFolder();
    const head = repo ? gitHead(repo) : { branch: null, commit: null };

    const record = {
        schema: SCHEMA,
        tourId,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: new Date().toISOString(),
        sessionId: entry.sourceSessionId || session.id,
        endpointId: entry.endpointId || null,
        repo,
        branch: entry.branch ?? head.branch,
        commit: entry.commit ?? head.commit,
        current: entry.current,
        ...(entry.provenance ? { provenance: entry.provenance } : {}),
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
            if (sessionId && record.sessionId !== sessionId) continue;
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

function liveTour(record, steps, staleness) {
    return {
        ...record,
        file: undefined,
        steps,
        staleness,
        sourceFile: undefined,
        sourceSessionId: record.sessionId,
    };
}

// --- routes -----------------------------------------------------------------

/**
 * The bound session's library, as the CLI sees it: what is loaded, what is only
 * on disk, and how much of each still describes the current code.
 */
function list(payload = {}) {
    const limit = Math.min(200, Math.max(1, Number.parseInt(payload.limit, 10) || 50));
    const includeSteps = payload.includeSteps === true;
    const includeArchived = payload.includeArchived === true;
    const session = findWorkspaceSession();
    const loaded = tour.getLibrary();
    const byId = new Map();
    const ownedLoaded = session
        ? loaded.tours.filter(
              (entry) =>
                  (!entry.sourceSessionId || entry.sourceSessionId === session.id) &&
                  (includeArchived || !entry.archivedAt),
          )
        : [];

    for (const entry of ownedLoaded) {
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
            archivedAt: entry.archivedAt,
            sessionId: entry.sourceSessionId,
            sourceFile: entry.sourceFile,
            // Present only for a tour that came off disk, and describing how it
            // resolved when it was read. A tour built in this window is current
            // by definition; a tally of zeros for it would read as "checked and
            // fine" rather than "not applicable".
            staleness: entry.staleness,
            stepDetail: includeSteps ? entry.steps.map(describeStep) : undefined,
        });
    }

    for (const record of session
        ? scan({ repo: payload.repo, sessionId: session.id })
        : []) {
        if (record.archivedAt && !includeArchived) continue;
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
            archivedAt: record.archivedAt,
            sessionId: record.sessionId,
            file: record.file,
            staleness,
            stepDetail: includeSteps ? steps.map(describeStep) : undefined,
        });
    }

    const tours = [...byId.values()].slice(0, limit);
    const activeTourId = byId.has(loaded.activeTourId) ? loaded.activeTourId : null;
    return {
        ok: true,
        result: { tours, activeTourId, loaded: ownedLoaded.length },
    };
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

function discover(payload = {}) {
    const current = findWorkspaceSession();
    const sourceSessionId = String(payload.sourceSessionId || "").trim() || null;
    const limit = Math.min(200, Math.max(1, Number.parseInt(payload.limit, 10) || 50));
    const tours = [];

    for (const record of scan({ repo: payload.repo })) {
        const legacy = classifyLegacy(record);
        if (record.sessionId === current?.id) {
            if (!payload.includeLegacyCurrent || legacy.status === "current") continue;
        }
        if (sourceSessionId && record.sessionId !== sourceSessionId) continue;
        if (payload.query) {
            const haystack = `${record.tourId} ${record.title || ""}`.toLowerCase();
            if (!haystack.includes(String(payload.query).toLowerCase())) continue;
        }

        const { staleness } = resolveSteps(record);
        tours.push({
            tourId: record.tourId,
            title: record.title,
            sourceSessionId: record.sessionId,
            repo: record.repo,
            branch: record.branch,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            archivedAt: record.archivedAt,
            ...(legacy.status === "current"
                ? {}
                : {
                      legacyStatus: legacy.status,
                      legacyEvidence: legacy.evidence,
                  }),
            steps: (record.steps || []).length,
            staleness,
        });
        if (tours.length >= limit) break;
    }

    return { ok: true, result: { tours } };
}

function classifyLegacy(record) {
    if (record.provenance) return { status: "current", evidence: null };

    const claimedSessionCreatedAt = createdAtForSession(
        path.join(sessionRoot(), record.sessionId || ""),
    );
    const recordCreatedAt = Date.parse(record.createdAt || "");
    const claimedIso = claimedSessionCreatedAt
        ? new Date(claimedSessionCreatedAt).toISOString()
        : null;

    if (!Number.isFinite(recordCreatedAt)) {
        return {
            status: "uncertain",
            evidence: {
                reason: "record creation time is missing or invalid",
                recordCreatedAt: record.createdAt || null,
                claimedSessionCreatedAt: claimedIso,
            },
        };
    }

    if (!claimedSessionCreatedAt) {
        return {
            status: "uncertain",
            evidence: {
                reason: "claiming Copilot session creation time is unavailable",
                recordCreatedAt: record.createdAt,
                claimedSessionCreatedAt: null,
            },
        };
    }
    if (recordCreatedAt < claimedSessionCreatedAt) {
        return {
            status: "legacy-copy",
            evidence: {
                reason: "record predates the Copilot session that claims it",
                recordCreatedAt: record.createdAt,
                claimedSessionCreatedAt: claimedIso,
            },
        };
    }
    return { status: "current", evidence: null };
}

async function cleanupLegacy(payload = {}) {
    const sourceSessionId = String(payload.sourceSessionId || "").trim();
    const sourceTourId = String(payload.sourceTourId || "").trim();
    if (!sourceSessionId || !SLUG_PATTERN.test(sourceTourId)) {
        return { ok: false, error: "sourceSessionId and sourceTourId are required" };
    }

    const record = scan({ sessionId: sourceSessionId }).find(
        (entry) => entry.tourId === sourceTourId,
    );
    if (!record) return { ok: false, error: "the legacy Tour record was not found" };

    const legacy = classifyLegacy(record);
    if (legacy.status !== "legacy-copy") {
        return {
            ok: false,
            error:
                legacy.status === "uncertain"
                    ? "that record is uncertain and cannot be cleaned up automatically"
                    : "that record is not a legacy foreign copy",
        };
    }

    const answer = await vscode.window.showWarningMessage(
        `Delete legacy Tour copy "${sourceTourId}" from session ${sourceSessionId}?`,
        {
            modal: true,
            detail:
                `${legacy.evidence.reason}: ${legacy.evidence.recordCreatedAt} predates ` +
                `${legacy.evidence.claimedSessionCreatedAt}. Only this exact stored copy will be deleted.`,
        },
        "Delete legacy copy",
    );
    if (answer !== "Delete legacy copy") {
        return { ok: true, deleted: false, cancelled: true };
    }

    try {
        fs.rmSync(record.file, { force: true });
    } catch (err) {
        return { ok: false, error: `could not delete the legacy Tour copy: ${err.message}` };
    }
    if (findWorkspaceSession()?.id === sourceSessionId) {
        tour.unload(sourceTourId);
    }
    return {
        ok: true,
        result: {
            deleted: record.file,
            sourceSessionId,
            sourceTourId,
            legacyEvidence: legacy.evidence,
        },
    };
}

function writeTourRecord(record) {
    const stored = { ...record };
    delete stored.file;
    const tmp = `${record.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
    fs.renameSync(tmp, record.file);
}

function setArchived(payload = {}) {
    const session = findWorkspaceSession();
    const tourId = String(payload.tourId || "").trim();
    if (!session) return { ok: false, error: "no Copilot session is bound to this window" };
    if (!SLUG_PATTERN.test(tourId)) return { ok: false, error: "a tourId is required" };

    const timer = pending.get(tourId);
    if (timer) {
        clearTimeout(timer);
        pending.delete(tourId);
        const saved = save(tourId);
        if (!saved.ok) return saved;
    }

    const record = scan({ sessionId: session.id }).find((entry) => entry.tourId === tourId);
    if (!record) return { ok: false, error: `no tour called '${tourId}' was found` };

    const archived = payload.archived !== false;
    const previousArchivedAt = record.archivedAt;
    if (archived) record.archivedAt = payload.archivedAt || new Date().toISOString();
    else delete record.archivedAt;
    record.updatedAt = new Date().toISOString();

    try {
        writeTourRecord(record);
    } catch (err) {
        return {
            ok: false,
            error: `could not ${archived ? "archive" : "unarchive"} the Tour: ${err.message}`,
        };
    }

    if (archived) {
        tour.unload(tourId);
    } else if (!tour.has(tourId)) {
        const loaded = loadFromDisk(tourId, session.id);
        if (!loaded.ok) {
            record.archivedAt = previousArchivedAt;
            record.updatedAt = new Date().toISOString();
            try {
                writeTourRecord(record);
            } catch (err) {
                return {
                    ok: false,
                    error:
                        `${loaded.error}; additionally could not restore archive state: ` +
                        err.message,
                };
            }
            return loaded;
        }
    }
    return {
        ok: true,
        result: { tourId, archived, archivedAt: record.archivedAt || null, file: record.file },
    };
}

function availableTourId(sessionId, preferred) {
    const used = new Set(scan({ sessionId }).map((record) => record.tourId));
    if (!used.has(preferred) && !tour.has(preferred)) return preferred;
    for (let number = 2; number < 1000; number += 1) {
        const suffix = `-${number}`;
        const candidate = `${preferred.slice(0, 64 - suffix.length)}${suffix}`;
        if (!used.has(candidate) && !tour.has(candidate)) return candidate;
    }
    return `${preferred.slice(0, 50)}-${Date.now()}`.slice(0, 64);
}

async function importTour(payload = {}) {
    const session = findWorkspaceSession();
    if (!session) return { ok: false, error: "no Copilot session is bound to this window" };

    const sourceSessionId = String(payload.sourceSessionId || "").trim();
    const sourceTourId = String(payload.sourceTourId || "").trim();
    if (!sourceSessionId || !SLUG_PATTERN.test(sourceTourId)) {
        return { ok: false, error: "sourceSessionId and sourceTourId are required" };
    }
    const source = scan({ sessionId: sourceSessionId }).find(
        (record) => record.tourId === sourceTourId,
    );
    if (!source) return { ok: false, error: "the source Tour was not found" };
    const legacy = classifyLegacy(source);
    if (sourceSessionId === session.id && legacy.status !== "legacy-copy") {
        return { ok: false, error: "that Tour already belongs to this Copilot session" };
    }

    const preferred = String(payload.targetTourId || sourceTourId).trim();
    if (!SLUG_PATTERN.test(preferred)) return { ok: false, error: "targetTourId is invalid" };

    const existing = scan({ sessionId: session.id }).find(
        (record) => record.tourId === preferred,
    );
    let tourId = preferred;
    if (existing && payload.replace === true) {
        const answer = await vscode.window.showWarningMessage(
            `Replace the Tour "${preferred}" in this Copilot session?`,
            { modal: true, detail: "The historical source Tour will not be changed." },
            "Replace",
        );
        if (answer !== "Replace") {
            return {
                ok: true,
                imported: false,
                cancelled: true,
                suggestedTourId: availableTourId(session.id, preferred),
            };
        }
        tour.unload(preferred);
    } else {
        tourId = availableTourId(session.id, preferred);
    }

    const importedAt = payload.importedAt || new Date().toISOString();
    const now = new Date().toISOString();
    const record = {
        ...source,
        file: undefined,
        tourId,
        sessionId: session.id,
        endpointId: null,
        current: -1,
        createdAt: now,
        updatedAt: now,
        archivedAt: undefined,
        provenance: {
            sourceSessionId,
            sourceTourId,
            importedAt,
            ...(legacy.status === "legacy-copy"
                ? { legacyEvidence: legacy.evidence }
                : {}),
        },
        steps: (source.steps || []).map((step) => ({ ...step })),
    };
    const file = fileFor(session.dir, tourId);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (err) {
        return { ok: false, error: `could not import the Tour: ${err.message}` };
    }

    const { steps, staleness } = resolveSteps(record);
    const adopted = tour.adopt(liveTour(record, steps, staleness));
    if (!adopted) return { ok: false, error: "the Tour Library is full; close a Tour first" };

    return {
        ok: true,
        result: { tourId, imported: true, file, provenance: record.provenance, staleness },
    };
}

/**
 * Switches to a Tour owned by the bound session, loading it from that session's
 * folder first if it is not in memory.
 */
async function activateTour(payload = {}) {
    const tourId = String(payload.tourId || "").trim();
    if (!SLUG_PATTERN.test(tourId)) return { ok: false, error: "a tourId is required" };
    const session = findWorkspaceSession();
    if (!session) {
        return { ok: false, error: "no Copilot session is bound to this window" };
    }

    if (!tour.has(tourId)) {
        const loaded = loadFromDisk(tourId, session.id);
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

function loadFromDisk(tourId, sessionId) {
    const record = scan({ sessionId }).find((r) => r.tourId === tourId);
    if (!record) return { ok: false, error: `no tour called '${tourId}' was found` };

    const { steps, staleness } = resolveSteps(record);
    if (steps.length === 0 || steps.every((s) => s.status === "missing")) {
        return {
            ok: false,
            error: "none of that tour's files are in this checkout",
            result: { tourId, staleness },
        };
    }

    const adopted = tour.adopt(liveTour(record, steps, staleness));
    if (!adopted) return { ok: false, error: "the tour library is full; close a tour first" };

    diag(`tour loaded from disk: ${tourId} ${JSON.stringify(staleness)}`);
    return { ok: true, result: { tourId, steps: steps.length, staleness } };
}

/** Unloads a tour and deletes its file. */
function remove(payload = {}) {
    const tourId = String(payload.tourId || "").trim();
    if (!SLUG_PATTERN.test(tourId)) return { ok: false, error: "a tourId is required" };
    const session = findWorkspaceSession();
    if (!session) {
        return { ok: false, error: "no Copilot session is bound to this window" };
    }

    const loadedEntry = tour.getTour(tourId);
    if (loadedEntry?.sourceSessionId && loadedEntry.sourceSessionId !== session.id) {
        return {
            ok: false,
            error: `tour '${tourId}' is owned by another Copilot session`,
        };
    }

    const unloaded = tour.unload(tourId);

    const timer = pending.get(tourId);
    if (timer) {
        // Otherwise a queued save would write the file back out moments after
        // it was deleted.
        clearTimeout(timer);
        pending.delete(tourId);
    }

    const deleted = [];
    for (const record of scan({ sessionId: session.id })) {
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
    const session = findWorkspaceSession();
    if (!session) return { restored: 0 };

    let restored = 0;
    for (const record of scan({ sessionId: session.id })) {
        if (tour.has(record.tourId)) continue;
        if (record.archivedAt) continue;
        // Older builds copied a borrowed tour into the current session on the
        // first cursor move. They preserved its original createdAt, so a tour
        // older than the session that allegedly created it is provably such a
        // clone. Leave it discoverable on disk, but do not auto-restore it.
        if (classifyLegacy(record).status === "legacy-copy") {
            diag(`skipped foreign tour clone during restore: ${record.tourId}`);
            continue;
        }
        const { steps, staleness } = resolveSteps(record);
        if (steps.length === 0) continue;
        if (
            tour.adopt(liveTour(record, steps, staleness))
        ) {
            restored += 1;
        }

    }

    if (restored) diag(`restored ${restored} tour(s) from this session`);
    return { restored };
}

function createdAtForSession(sessionDir) {
    try {
        const yaml = fs.readFileSync(path.join(sessionDir, "workspace.yaml"), "utf8");
        const match = /^created_at:\s*(.+?)\s*$/m.exec(yaml);
        const value = match ? Date.parse(match[1]) : Number.NaN;
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
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
        vscode.commands.registerCommand("porthole.tour.archive", (arg) => {
            const tourId = idOf(arg);
            if (!tourId) return;
            const result = setArchived({ tourId, archived: true });
            vscode.window.showInformationMessage(
                result.ok ? `porthole: archived '${tourId}'.` : `porthole: ${result.error}`,
            );
        }),
        vscode.commands.registerCommand("porthole.tour.restoreArchived", async () => {
            const archived = list({ includeArchived: true }).result.tours.filter(
                (entry) => entry.archivedAt,
            );
            if (archived.length === 0) {
                vscode.window.showInformationMessage(
                    "porthole: this Copilot session has no archived Tours.",
                );
                return;
            }
            const picked = await vscode.window.showQuickPick(
                archived.map((entry) => ({
                    label: entry.title || entry.tourId,
                    description: entry.tourId,
                    detail: `Archived ${entry.archivedAt}`,
                    tourId: entry.tourId,
                })),
                { placeHolder: "Choose a Tour to return to this session's Tour Library" },
            );
            if (!picked) return;
            const result = setArchived({ tourId: picked.tourId, archived: false });
            vscode.window.showInformationMessage(
                result.ok
                    ? `porthole: unarchived '${picked.tourId}'.`
                    : `porthole: ${result.error}`,
            );
        }),
    );

    // Deferred: findSession reads the workspace folders, which are not settled
    // at the instant activation runs.
    //
    // Tried immediately and then retried, rather than sleeping a flat second
    // and a half. restore() is idempotent and only does real work once a
    // session folder is visible, so the common case - folders already settled -
    // costs nothing, and a workspace that settles late is still picked up.
    let attempt = 0;
    let restoreTimer = null;
    const tryRestore = () => {
        restoreTimer = null;
        let found = false;
        try {
            found = Boolean(findWorkspaceSession());
            if (found) restore();
        } catch (err) {
            diag(`tour restore failed: ${err.message}`);
            found = true; // a failing restore is not worth retrying in a loop
        }
        attempt += 1;
        if (found || attempt > RESTORE_RETRY_MS.length) return;
        restoreTimer = setTimeout(tryRestore, RESTORE_RETRY_MS[attempt - 1]);
    };
    tryRestore();
    context.subscriptions.push({
        dispose: () => {
            if (restoreTimer) clearTimeout(restoreTimer);
        },
    });
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
    discover,
    importTour,
    setArchived,
    cleanupLegacy,
    activateTour,
    remove,
    // internals, exported for the doctor and for probes
    save,
    flush,
    restore,
    scan,
    resolveSteps,
    classifyLegacy,
    toursDir,
};
