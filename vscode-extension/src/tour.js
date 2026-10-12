// Walkthrough mode.
//
// An annotation set answers "look at these places". A tour answers "follow this
// path, in this order, and here is why each step matters" - which is what an
// explanation actually is.
//
// A *library* of tours, because a change worth explaining rarely has one
// thread. A pull request has the auth path, the error handling and the
// migration, and cramming those into one 50-step walk is not an explanation,
// it is a list. So many tours can be loaded at once and each appears in the
// Problems panel, but exactly one is active - you can only follow one path
// with your eyes at a time, and the gutter would be nonsense otherwise.
//
// Four surfaces, because a walkthrough has to be discoverable without reading
// the docs:
//
//   CodeLens   inline above the step, with the narration and Next/Prev/Exit
//   gutter     a marker per step showing done / here / still to come
//   status bar "Step 3/9", click to advance
//   sidebar    the whole library, and the active tour's path, at a glance
//
// The state lives here and the surfaces read from it, so they can never
// disagree about which tour is active or which step is current.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const vscode = require("vscode");

const { diag } = require("./log");
const { clampRange } = require("./reveal");
const diagnostics = require("./diagnostics");
const anchors = require("./anchors");
const { gitRevision, normaliseRepo, normaliseSlug } = require("./repo");
const { findWorkspaceSession } = require("./session");

const MAX_STEPS = 50;
const MAX_NARRATION = 2000;
const LENS_TITLE_MAX = 90;
const OID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * How many tours may be loaded at once.
 *
 * Each one costs a diagnostic collection and a row in the sidebar. Well past
 * anything a real review needs, but not unbounded.
 */
const MAX_TOURS = 30;

/** tourId -> tour. Insertion-ordered, which is what the sidebar shows. */
const tours = new Map();

/** The one being walked, or null. */
let activeTourId = null;

let statusBar = null;
let decorations = null;
let extensionUri = null;

const lensChanged = new vscode.EventEmitter();
const stateChanged = new vscode.EventEmitter();

/** Fires when the library, the active tour or the cursor changes. */
const onDidChangeState = stateChanged.event;

/** Set by tourstore once it is wired up, to avoid a require cycle. */
let persistence = { publication: null, progress: null };

function setPersistenceHandlers(handlers = {}) {
    persistence = {
        publication:
            typeof handlers.publication === "function" ? handlers.publication : null,
        progress: typeof handlers.progress === "function" ? handlers.progress : null,
    };
}

// --- state ------------------------------------------------------------------

function active() {
    return activeTourId ? tours.get(activeTourId) || null : null;
}

function isActive() {
    const tour = active();
    return Boolean(tour && tour.steps.length > 0);
}

/**
 * The active tour, in the shape every surface already expects.
 *
 * Deliberately unchanged by the move to a library: views.js, reviews.js and the
 * status bar all read this, and widening it would have turned a contained
 * change into a rewrite. `getLibrary()` is the new door.
 */
function getState() {
    const tour = active();
    if (!tour) return { title: null, steps: [], current: -1 };
    return { title: tour.title, steps: tour.steps, current: tour.current, tourId: tour.tourId };
}

/** Everything loaded, newest last, plus which one is being walked. */
function getLibrary() {
    return { tours: [...tours.values()], activeTourId };
}

function getTour(tourId) {
    return tours.get(tourId) || null;
}

function comparisonStep(step) {
    if (!step) return null;
    return {
        file: step.file,
        startLine: step.startLine,
        endLine: step.endLine,
    };
}

function copyComparison(comparison) {
    return comparison
        ? { ...comparison, renames: { ...comparison.renames } }
        : null;
}

function comparisonDetails(entry) {
    const comparison = entry?.publication?.comparison;
    if (!comparison) return null;
    return {
        tourId: entry.tourId,
        publicationId: entry.publication.id || entry.publicationId,
        repo: entry.publication.repo || entry.repo || null,
        comparison: copyComparison(comparison),
    };
}

function activeComparison() {
    const entry = active();
    const details = comparisonDetails(entry);
    if (!details) return null;
    return {
        ...details,
        step: comparisonStep(entry.steps[entry.current]),
    };
}

function tourComparison(tourId) {
    const entry = tours.get(tourId);
    const details = comparisonDetails(entry);
    if (!details) return null;
    return {
        ...details,
        steps: entry.steps.map(comparisonStep),
    };
}

function has(tourId) {
    return tours.has(tourId);
}

function ownsPresentation(entry) {
    const session = findWorkspaceSession();
    return Boolean(session && entry.sourceSessionId === session.id &&
        (!entry.sourceSessionPath || path.relative(entry.sourceSessionPath, session.dir) === ""));
}

function presentationRefusal() {
    return { ok: false, reason: "ownership-refused", error: "the Tour is not owned by this window's current Copilot session" };
}

/** Advisory refreshes update the sidebar, not the current step or its anchors. */
function updateRevisionStates(updates) {
    let updated = false;
    for (const update of updates) {
        const entry = tours.get(update.tourId);
        if (!entry || (entry.publication?.id || entry.publicationId) !== update.publicationId) continue;
        if (entry.revisionState === update.revisionState) continue;
        entry.revisionState = update.revisionState;
        updated = true;
    }
    if (updated) stateChanged.fire(getState());
}

/**
 * Announces a state change once, to every surface.
 *
 * CodeLenses are deliberately refreshed from here and nowhere else. Firing on
 * document changes as well would re-render the lenses on every keystroke, which
 * reads as flicker.
 */
function changed({ progress } = {}) {
    lensChanged.fire();
    stateChanged.fire(getState());
    updateStatusBar();
    applyToAllVisible();
    void vscode.commands.executeCommand("setContext", "porthole.tourActive", isActive());
    void vscode.commands.executeCommand("setContext", "porthole.tourLibrary", tours.size > 0);
    if (progress && persistence.progress) persistence.progress(progress);
}

function normalise(raw, index, options = {}) {
    const startLine = toInt(raw.startLine, 1);
    const endLine = Math.max(startLine, toInt(raw.endLine, startLine));
    const status =
        options.preserveStatus &&
        ["resolved", "shifted", "changed", "missing"].includes(raw.status)
            ? raw.status
            : null;
    return {
        index,
        file: raw.file,
        startLine,
        endLine,
        stepTitle: text(raw.stepTitle, 200) || `Step ${index + 1}`,
        narration: text(raw.narration, MAX_NARRATION),
        severity: ["info", "warn", "error", "note"].includes(raw.severity) ? raw.severity : "info",
        // Only set on a step that came off disk. Carried through so a restored
        // tour can still say which of its steps have drifted - dropping it here
        // was how a tour loaded from three commits ago looked perfectly current.
        ...(status ? { status } : {}),
        // Likewise carried rather than recomputed. The anchor records what the
        // narration was written about; re-deriving it from whatever now sits at
        // the step would quietly turn a stale tour into a current-looking one.
        ...(raw.anchor && raw.anchor.sha256 ? { anchor: raw.anchor } : {}),
        ...(options.inheritedEvidence ? { inheritedEvidence: true } : {}),
    };
}

/**
 * How a step should be shown, as opposed to how it was written.
 *
 * Derived rather than stored, for the same reason the "this code has moved"
 * note is: a display decision written back to disk is a display decision that
 * accumulates, and here it would also destroy the severity the caller chose.
 */
function displaySeverity(step) {
    return step.status === "changed" ? "warn" : step.severity;
}

function text(value, max) {
    const s = typeof value === "string" ? value.trim() : "";
    return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validOid(value) {
    return value === null || (typeof value === "string" && OID_PATTERN.test(value));
}

function validRelativePosixPath(value) {
    if (typeof value !== "string" || value.trim().length === 0) return false;
    if (CONTROL_PATTERN.test(value) || value.includes("\\") || value.startsWith("/")) {
        return false;
    }
    if (/^[a-zA-Z]:/.test(value)) return false;
    const segments = value.split("/");
    return !segments.some((segment) => !segment || segment === "." || segment === "..");
}

function validateComparison(value, repo) {
    if (value === undefined || value === null) {
        return { ok: true, comparison: null };
    }
    if (!repo) return { ok: false, error: "sourceRepo is required" };
    if (!isPlainObject(value)) return { ok: false, error: "comparison must be a plain object" };
    if (!["live", "revisions"].includes(value.kind)) {
        return { ok: false, error: "kind must be 'live' or 'revisions'" };
    }
    if (!validOid(value.base)) {
        return { ok: false, error: "base must be a lowercase 40- or 64-character OID, or null" };
    }
    if (!validOid(value.target)) {
        return { ok: false, error: "target must be a lowercase 40- or 64-character OID, or null" };
    }
    if (value.kind === "live" && value.target !== null) {
        return { ok: false, error: "live comparisons require a null target" };
    }
    if (value.kind === "revisions" && value.target === null) {
        return { ok: false, error: "revision comparisons require a target OID" };
    }

    const label = typeof value.label === "string" ? value.label.trim() : "";
    if (!label) return { ok: false, error: "label must be a non-empty string" };
    if (label.length > 120) return { ok: false, error: "label is limited to 120 characters" };
    if (CONTROL_PATTERN.test(label)) {
        return { ok: false, error: "label must not contain control characters" };
    }
    if (!isPlainObject(value.renames)) {
        return { ok: false, error: "renames must be a plain object" };
    }
    const renameEntries = Object.entries(value.renames);
    if (renameEntries.length > MAX_STEPS) {
        return { ok: false, error: `renames is limited to ${MAX_STEPS} entries` };
    }
    for (const [newPath, oldPath] of renameEntries) {
        if (!validRelativePosixPath(newPath) || !validRelativePosixPath(oldPath)) {
            return {
                ok: false,
                error: "rename paths must be non-empty relative POSIX paths without dot segments",
            };
        }
    }
    if (
        value.renamesComplete !== undefined &&
        typeof value.renamesComplete !== "boolean"
    ) {
        return { ok: false, error: "renamesComplete must be a boolean" };
    }

    return {
        ok: true,
        comparison: {
            kind: value.kind,
            label,
            base: value.base,
            target: value.target,
            renames: Object.fromEntries(renameEntries),
            renamesComplete: value.renamesComplete ?? true,
        },
    };
}

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolves a step's file, allowing paths relative to a workspace folder.
 *
 * Existence is checked for absolute paths too. Taking them on trust meant a
 * tour could be accepted with steps pointing at files that were never there,
 * and only fall over later with a popup per step - the caller having already
 * been told everything was fine.
 */
function resolveFile(file) {
    if (!file) return null;

    if (path.isAbsolute(file)) return exists(file) ? file : null;

    for (const folder of vscode.workspace.workspaceFolders || []) {
        const candidate = path.join(folder.uri.fsPath, file);
        if (exists(candidate)) return candidate;
    }
    return null;
}

function exists(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

// --- the route --------------------------------------------------------------

/**
 * Turns a title into a filename-safe id, without colliding with a tour that is
 * already loaded.
 *
 * A caller that supplies its own `tourId` is taken at its word - repeating an
 * id is how you deliberately replace a tour.
 */
function slugFor(payload) {
    if (payload.tourId) {
        const explicit = normaliseSlug(payload.tourId);
        return explicit || "tour";
    }
    const base = normaliseSlug(payload.title || "") || "tour";
    if (!tours.has(base)) return base;

    for (let n = 2; n < 1000; n += 1) {
        const suffix = `-${n}`;
        const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
        if (!tours.has(candidate)) return candidate;
    }
    return `${base.slice(0, 51)}-${randomUUID().slice(0, 12)}`;
}

/**
 * Adds a tour to the library, or replaces one with the same id.
 *
 * Naming an existing id requests replacement unless `replace` is false.
 * An automatically derived title must not replace an archived or unloaded Tour.
 */
async function upsert(payload = {}) {
    const session = findWorkspaceSession();
    if (!session) return { ok: false, error: "no Copilot session is bound to this window" };
    const expectedSession = { id: session.id, dir: session.dir };
    const incoming = Array.isArray(payload.steps) ? payload.steps : [];
    if (incoming.length === 0) return { ok: false, error: "a tour needs at least one step" };
    if (incoming.length > MAX_STEPS) {
        return { ok: false, error: `a tour is limited to ${MAX_STEPS} steps` };
    }
    const repo = normaliseRepo(payload.sourceRepo);
    const checkedComparison = validateComparison(payload.comparison, repo);
    if (!checkedComparison.ok) {
        return {
            ok: false,
            error: `invalid Recorded comparison: ${checkedComparison.error}`,
        };
    }
    const comparison = checkedComparison.comparison;

    const tourId = slugFor(payload);
    const existing = tours.get(tourId);
    if (existing && payload.replace === false) {
        return {
            ok: false,
            error: `a tour called '${tourId}' is already loaded; pass replace to overwrite it, or use a different tourId`,
        };
    }

    if (!existing && tours.size >= MAX_TOURS) {
        return {
            ok: false,
            error: `${MAX_TOURS} tours are already loaded; close or delete one first`,
        };
    }

    const accepted = [];
    const skipped = [];
    const sourceLines = new Map();

    for (const [i, raw] of incoming.entries()) {
        if (!raw || !raw.file) {
            skipped.push({ index: i, reason: "step has no 'file'" });
            continue;
        }
        const file = resolveFile(raw.file);
        if (!file) {
            // Reported rather than dropped: a tour that quietly loses a step is
            // an explanation with a hole in it.
            skipped.push({ index: i, reason: `file not found: ${raw.file}` });
            continue;
        }

        const authored = normalise(
            {
                file,
                startLine: raw.startLine,
                endLine: raw.endLine,
                stepTitle: raw.stepTitle,
                narration: raw.narration,
                severity: raw.severity,
            },
            accepted.length,
        );
        if (!sourceLines.has(file)) sourceLines.set(file, anchors.readLines(file));
        const lines = sourceLines.get(file);
        if (Array.isArray(lines)) {
            authored.endLine = Math.min(authored.endLine, lines.length);
        }
        const anchor = anchors.anchorFromLines(
            lines,
            authored.startLine,
            authored.endLine,
        );
        if (!anchor) {
            skipped.push({
                index: i,
                reason: `could not capture saved source evidence from ${file}`,
            });
            continue;
        }
        authored.anchor = anchor;
        accepted.push(authored);
    }

    if (accepted.length === 0) {
        return { ok: false, error: "no step could be resolved", result: { steps: 0, skipped } };
    }

    if (!persistence.publication) {
        return { ok: false, error: "Tour publication storage is unavailable" };
    }

    const head = await gitRevision(repo);
    const now = new Date().toISOString();
    const entry = {
        tourId,
        title: text(payload.title, 200) || existing?.title || tourId,
        steps: accepted,
        current: -1,
        endpointId: payload.endpointId || existing?.endpointId || null,
        sourceSessionId: expectedSession.id,
        sourceSessionPath: expectedSession.dir,
        repo,
        branch: head.branch,
        commit: head.commit,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        publication: {
            id: randomUUID(),
            at: now,
            repo,
            commit: head.commit,
            ...(comparison ? { comparison } : {}),
        },
        revisionState: head.commit ? "same-revision" : "unknown",
    };

    const persisted = await persistence.publication(entry, {
        replace: Boolean(payload.tourId) && payload.replace !== false,
        expectedSession,
    });
    if (!persisted?.ok) {
        return {
            ok: false,
            error: persisted?.error || "could not save the Tour publication",
            result: { tourId, steps: accepted.length, skipped, saved: false },
        };
    }

    Object.assign(entry, {
        createdAt: persisted.result?.createdAt || entry.createdAt,
        updatedAt: persisted.result?.updatedAt || entry.updatedAt,
        sourceFile: persisted.result?.file,
        sourceSessionId: persisted.result?.sessionId,
        publicationId: entry.publication.id,
    });

    if (activeTourId === tourId) {
        activeTourId = null;
        clearDecorations();
    }
    tours.set(tourId, entry);

    publishTour(tourId);
    changed();

    const activate = payload.activate !== false && payload.start !== false;
    if (activate) {
        const activation = await activateTour(tourId, 0);
        if (!activation.ok) {
            diag(
                `tour ${existing ? "replaced" : "added"} but not displayed: ${tourId} ` +
                    `(${activation.error || activation.reason})`,
            );
            return {
                ok: false,
                reason: activation.reason || "display-failed",
                error: activation.error || "the Tour was saved but its first step was not shown",
                result: {
                    tourId,
                    replaced: Boolean(existing),
                    steps: accepted.length,
                    skipped,
                    saved: true,
                    displayed: false,
                    active: false,
                    library: tours.size,
                    file: persisted.result?.file,
                },
            };
        }
    }

    diag(
        `tour ${existing ? "replaced" : "added"}: ${tourId} (${accepted.length} steps, ` +
            `${skipped.length} skipped, library ${tours.size})`,
    );

    return {
        ok: true,
        result: {
            tourId,
            replaced: Boolean(existing),
            steps: accepted.length,
            skipped,
            active: activeTourId === tourId,
            saved: true,
            displayed: activate,
            file: persisted.result?.file,
            publication: entry.publication,
            ...(comparison ? { comparisonRecorded: true } : {}),
            library: tours.size,
        },
    };
}

/** Kept for the pre-library route name. */
const start = upsert;

/** Publishes one tour's steps into its own diagnostic layer. */
function publishTour(tourId) {
    const tour = tours.get(tourId);
    if (!tour) return;
    diagnostics.publish(
        layerFor(tourId),
        tour.steps
            // A step whose file has gone cannot be marked up. It is kept in the
            // tour - the file may come back with the branch - but there is
            // nothing to point at meanwhile.
            .filter((s) => s.status !== "missing")
            .map((s) => ({ ...s, severity: displaySeverity(s), message: s.stepTitle })),
        tour.title,
    );
}

/** Re-publishes every loaded tour, e.g. when a display setting changes. */
function republishAll() {
    for (const tourId of tours.keys()) publishTour(tourId);
}

function layerFor(tourId) {
    return `tour:${tourId}`;
}

// --- navigation -------------------------------------------------------------

async function goto(index) {
    const tour = active();
    if (!tour) {
        vscode.window.showInformationMessage("porthole: no tour is running.");
        return { ok: false, error: "no tour is running" };
    }
    if (!ownsPresentation(tour)) return presentationRefusal();
    if (!Number.isInteger(index) || index < 0 || index >= tour.steps.length) {
        return { ok: false, error: `step ${index} is outside this Tour` };
    }

    const entry = tour.steps[index];
    if (entry.status === "missing") {
        // Said once, plainly, rather than as a failure to open a file: the step
        // is still part of the explanation, its file just is not here - a
        // different branch, an uninitialised submodule, a moved checkout.
        vscode.window.showInformationMessage(
            `porthole: step ${index + 1} points at ${entry.file}, which is not in this checkout.`,
        );
        return {
            ok: false,
            reason: "missing",
            error: `step ${index + 1} points at a file that is not in this checkout`,
            file: entry.file,
        };
    }

    const revealed = await revealStep(entry, tour);
    if (!revealed.ok) return revealed;

    tour.current = index;
    tour.updatedAt = new Date().toISOString();
    changed({ progress: tour.tourId });
    return {
        ok: true,
        result: {
            tourId: tour.tourId,
            current: index,
            file: entry.file,
            displayed: true,
        },
    };
}

async function step(delta) {
    const tour = active();
    if (!tour) {
        vscode.window.showInformationMessage("porthole: no tour is running.");
        return;
    }
    // Wraps, so stepping past the end returns to the start rather than
    // dead-ending on the last step.
    await goto((tour.current + delta + tour.steps.length) % tour.steps.length);
}

/**
 * Switches which tour is being walked.
 *
 * The tour being switched away from stays in the library and in the Problems
 * panel; only the gutter, the lenses and the status bar follow the active one.
 */
async function activateTour(tourId, stepIndex) {
    const tour = tours.get(tourId);
    if (!tour) return { ok: false, error: `no tour called '${tourId}' is loaded` };
    if (!ownsPresentation(tour)) return presentationRefusal();

    const index = Number.isInteger(stepIndex)
        ? Math.max(0, Math.min(tour.steps.length - 1, stepIndex))
        : tour.current >= 0
          ? tour.current
          : 0;

    const entry = tour.steps[index];
    if (entry.status === "missing") {
        return {
            ok: false,
            reason: "missing",
            error: `step ${index + 1} points at a file that is not in this checkout`,
            file: entry.file,
        };
    }

    const revealed = await revealStep(entry, tour);
    if (!revealed.ok) return revealed;

    activeTourId = tourId;
    tour.current = index;
    tour.updatedAt = new Date().toISOString();
    changed({ progress: tourId });
    diag(`tour activated: ${tourId} at step ${index + 1}/${tour.steps.length}`);
    return {
        ok: true,
        result: {
            tourId,
            title: tour.title,
            steps: tour.steps.length,
            current: tour.current,
            displayed: true,
            revisionState: tour.revisionState || "unknown",
        },
    };
}

/**
 * Stops walking a tour without unloading it.
 *
 * It stays in the library, on disk, and in the Problems panel - closing is
 * "I have finished with this for now", not "throw it away".
 */
function close(tourId) {
    const id = tourId || activeTourId;
    if (!id) return { ok: false, error: "no tour is active" };
    if (!tours.has(id)) return { ok: false, error: `no tour called '${id}' is loaded` };

    if (activeTourId === id) {
        activeTourId = null;
        clearDecorations();
    }
    changed();
    return { ok: true, result: { tourId: id, library: tours.size } };
}

/** Stops walking whatever is active. The pre-library name for `close`. */
function exit() {
    if (!activeTourId) return { ok: true, result: { library: tours.size } };
    return close(activeTourId);
}

/** Unloads every tour, and forgets the library. Does not touch what is on disk. */
function closeAll() {
    const count = tours.size;
    for (const tourId of tours.keys()) diagnostics.dispose(layerFor(tourId));
    tours.clear();
    activeTourId = null;
    clearDecorations();
    changed();
    diag(`tour library cleared: ${count} unloaded`);
    return { ok: true, result: { unloaded: count } };
}

/**
 * Takes a tour out of the library.
 *
 * Deleting the file is the store's job; this drops the in-memory state and the
 * diagnostics, which would otherwise leave the Problems panel describing a tour
 * that no longer exists.
 */
function unload(tourId) {
    if (!tours.has(tourId)) return false;
    diagnostics.dispose(layerFor(tourId));
    tours.delete(tourId);
    if (activeTourId === tourId) {
        activeTourId = null;
        clearDecorations();
    }
    changed();
    return true;
}

/**
 * Puts a tour into the library without going through resolution.
 *
 * Used when loading from disk, where the steps have already been resolved and
 * re-anchored by the store.
 */
function adopt(tour) {
    if (!tour || !tour.tourId || !Array.isArray(tour.steps) || tour.steps.length === 0) {
        return false;
    }
    if (!tours.has(tour.tourId) && tours.size >= MAX_TOURS) return false;

    const steps = tour.steps.map((s, i) =>
        normalise(s, i, { preserveStatus: true, inheritedEvidence: true }),
    );
    const current = Number.isInteger(tour.current)
        ? Math.max(-1, Math.min(steps.length - 1, tour.current))
        : -1;

    tours.set(tour.tourId, { ...tour, steps, current });
    publishTour(tour.tourId);
    changed();
    return true;
}

async function revealStep(entry, owner) {
    let document;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
    } catch (err) {
        diag(`tour reveal failed: ${err.message}`);
        vscode.window.showWarningMessage(`porthole: could not open ${entry.file}`);
        return { ok: false, reason: "display-failed", error: `could not open ${entry.file}` };
    }

    if (!ownsPresentation(owner)) return presentationRefusal();
    if (document.isDirty) {
        const error = `save ${entry.file} before showing this Tour step`;
        vscode.window.showWarningMessage(`porthole: ${error}.`);
        return { ok: false, reason: "requires-save", error, file: entry.file };
    }

    let editor;
    try {
        editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
        });
    } catch (err) {
        diag(`tour display failed: ${err.message}`);
        return {
            ok: false,
            reason: "display-failed",
            error: `could not show ${entry.file}: ${err.message}`,
        };
    }
    const range = clampRange(document, entry.startLine, entry.endLine, 1, undefined);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return { ok: true, result: { file: entry.file } };
}

async function list() {
    const tour = active();
    if (!tour) {
        vscode.window.showInformationMessage("porthole: no tour is running.");
        return;
    }
    const { steps, current } = tour;
    const picked = await vscode.window.showQuickPick(
        steps.map((s) => ({
            label: `${s.index === current ? "$(play)" : "$(circle-outline)"} ${s.index + 1}. ${s.stepTitle}`,
            description: `${shortName(s.file)}:${s.startLine}`,
            detail: firstLine(s.narration),
            index: s.index,
        })),
        { title: tour.title || "porthole tour", placeHolder: "Jump to a step", matchOnDetail: true },
    );
    if (picked) await goto(picked.index);
}

/**
 * Switching tours, from the keyboard.
 *
 * The sidebar shows the library, but a quick-pick is what you reach for when
 * you are already reading code and do not want to leave it.
 */
async function switchTour() {
    if (tours.size === 0) {
        vscode.window.showInformationMessage(
            "porthole: no tours are loaded. Ask Copilot to walk you through something.",
        );
        return;
    }
    const picked = await vscode.window.showQuickPick(
        [...tours.values()].map((t) => ({
            label: `${t.tourId === activeTourId ? "$(play)" : "$(compass)"} ${t.title}`,
            description: `${t.steps.length} steps`,
            detail: t.tourId === activeTourId ? "currently active" : t.tourId,
            tourId: t.tourId,
        })),
        { title: "porthole: tours", placeHolder: "Switch to a tour", matchOnDetail: true },
    );
    if (picked) await activateTour(picked.tourId);
}

// --- gutter -----------------------------------------------------------------

function buildDecorations() {
    clearDecorations();
    const icon = (name) => vscode.Uri.joinPath(extensionUri, "media", name);
    decorations = {
        current: vscode.window.createTextEditorDecorationType({
            gutterIconPath: icon("tour-current.svg"),
            gutterIconSize: "contain",
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
        }),
        visited: vscode.window.createTextEditorDecorationType({
            gutterIconPath: icon("tour-visited.svg"),
            gutterIconSize: "contain",
        }),
        pending: vscode.window.createTextEditorDecorationType({
            gutterIconPath: icon("tour-pending.svg"),
            gutterIconSize: "contain",
        }),
    };
}

function clearDecorations() {
    if (!decorations) return;
    for (const type of Object.values(decorations)) type.dispose();
    decorations = null;
}

function applyTo(editor) {
    if (!editor) return;
    if (!decorations) buildDecorations();

    if (editor.document.isDirty) {
        for (const type of Object.values(decorations)) editor.setDecorations(type, []);
        return;
    }

    const tour = active();
    // The gutter follows the active tour only. Painting every loaded tour would
    // put three different "step 1" markers on the same line with no way to tell
    // which walk they belong to; the Problems panel is where the whole library
    // is visible at once.
    const mine = tour
        ? tour.steps.filter((s) => samePath(s.file, editor.document.uri.fsPath))
        : [];
    const current = tour ? tour.current : -1;
    const buckets = { current: [], visited: [], pending: [] };

    for (const s of mine) {
        const bucket = s.index === current ? "current" : s.index < current ? "visited" : "pending";
        buckets[bucket].push({
            range: clampRange(editor.document, s.startLine, s.endLine, 1, undefined),
            hoverMessage: hover(s, tour),
        });
    }

    for (const [name, options] of Object.entries(buckets)) {
        editor.setDecorations(decorations[name], options);
    }
}

function applyToAllVisible() {
    for (const editor of vscode.window.visibleTextEditors) applyTo(editor);
}

function samePath(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase();
}

function hover(s, tour) {
    const md = new vscode.MarkdownString();
    // Never trusted: the narration is model-written, and a trusted
    // MarkdownString can embed command links.
    md.isTrusted = false;
    const total = tour ? tour.steps.length : 0;
    if (tour?.title) md.appendMarkdown(`_${tour.title}_\n\n`);
    md.appendMarkdown(`**Step ${s.index + 1}/${total}** · ${s.stepTitle}\n\n`);
    if (s.narration) md.appendMarkdown(s.narration);
    const note = staleNote(s.status);
    if (note) md.appendMarkdown(`\n\n${note}`);
    return md;
}

/**
 * Said here rather than baked into the narration.
 *
 * Appending it to the stored text would mean the note was saved back with the
 * tour and appended again on the next load, so a tour read three times would
 * carry three copies of the same warning.
 */
function staleNote(status) {
    if (status === "shifted") return "_(this code moved since the tour was saved)_";
    if (status === "changed") {
        return "_(the code here has changed since the tour was saved, so this step may no longer apply)_";
    }
    return "";
}

// --- code lens --------------------------------------------------------------

/**
 * The lens is the whole point of the feature: the narration sits directly above
 * the code it describes, with the controls right there, so stepping through
 * never requires looking away.
 */
const lensProvider = {
    onDidChangeCodeLenses: lensChanged.event,

    provideCodeLenses(document) {
        const tour = active();
        if (!tour || tour.steps.length === 0 || document.isDirty) return [];

        const { steps, current } = tour;
        const mine = steps.filter((s) => samePath(s.file, document.uri.fsPath));
        const lenses = [];

        for (const s of mine) {
            const line = Math.max(0, Math.min(document.lineCount - 1, s.startLine - 1));
            const range = new vscode.Range(line, 0, line, 0);
            const position = `${s.index + 1}/${steps.length}`;

            if (s.index !== current) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: `${s.status === "changed" ? "$(warning)" : "$(circle-outline)"} Step ${position} — ${s.stepTitle}`,
                        command: "porthole.tour.goto",
                        arguments: [s.index],
                    }),
                );
                continue;
            }

            lenses.push(
                new vscode.CodeLens(range, {
                    title: `$(play) Step ${position} — ${lensText(s)}`,
                    command: "porthole.tour.list",
                }),                new vscode.CodeLens(range, {
                    title: "$(arrow-right) Next",
                    command: "porthole.tour.next",
                }),
                new vscode.CodeLens(range, {
                    title: "$(arrow-left) Prev",
                    command: "porthole.tour.previous",
                }),
                new vscode.CodeLens(range, { title: "$(x) Exit", command: "porthole.tour.exit" }),
            );

            if (tour.publication?.comparison) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: "$(diff) Diff",
                        tooltip: "Open the Step diff for this step; the Tour does not move",
                        command: "porthole.tour.diff",
                    }),
                );
            }

            // Only worth the line when there is somewhere else to switch to.
            if (tours.size > 1) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(list-unordered) ${tours.size} tours`,
                        command: "porthole.tour.switch",
                    }),
                );
            }
        }
        return lenses;
    },
};

/** A lens is one line, so the narration is trimmed to its first sentence. */
function lensText(s) {
    const body = firstLine(s.narration);
    if (!body) return s.stepTitle;
    const combined = `${s.stepTitle}: ${body}`;
    return combined.length > LENS_TITLE_MAX
        ? `${combined.slice(0, LENS_TITLE_MAX - 3)}...`
        : combined;
}

function firstLine(value) {
    const line = String(value || "").split(/\r?\n/)[0].replace(/[*_`#]/g, "").trim();
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function shortName(file) {
    return String(file).split(/[\\/]/).pop();
}

// --- status bar -------------------------------------------------------------

function updateStatusBar() {
    if (!statusBar) return;
    const tour = active();
    if (!tour) {
        // Still worth showing that tours are waiting - otherwise a library
        // loaded from disk is invisible until you find the sidebar.
        if (tours.size > 0) {
            statusBar.text = `$(compass) porthole: ${tours.size} tour${tours.size === 1 ? "" : "s"}`;
            statusBar.tooltip = "Click to pick a tour to walk.";
            statusBar.command = "porthole.tour.switch";
            statusBar.show();
            return;
        }
        statusBar.hide();
        return;
    }

    const { steps, current } = tour;
    const position = current >= 0 ? `${current + 1}/${steps.length}` : `${steps.length} steps`;
    statusBar.text = `$(play) porthole: Step ${position}`;
    statusBar.tooltip =
        `${tour.title || "porthole tour"}\n\nClick for the next step.` +
        (tours.size > 1 ? `\n\n${tours.size} tours loaded.` : "");
    statusBar.command = "porthole.tour.next";
    statusBar.show();
}

// --- lifecycle --------------------------------------------------------------

/**
 * A tour id, from either a bare string or a tree node.
 *
 * The tree passes its own item to a context-menu command, so both have to work
 * or the menu entries silently do nothing.
 */
function idOf(arg) {
    if (typeof arg === "string") return arg;
    const id = arg && typeof arg.id === "string" ? arg.id : "";
    return id.startsWith("tour-") ? id.slice("tour-".length) : "";
}

function activate(context) {
    extensionUri = context.extensionUri;
    buildDecorations();

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    statusBar.command = "porthole.tour.next";
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider),
        // Decorations are per-editor and lost when an editor closes, so the
        // stored state is the source of truth and is re-applied here.
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) applyTo(editor);
        }),
        vscode.commands.registerCommand("porthole.tour.next", () => step(1)),
        vscode.commands.registerCommand("porthole.tour.previous", () => step(-1)),
        vscode.commands.registerCommand("porthole.tour.goto", (index) => goto(index)),
        vscode.commands.registerCommand("porthole.tour.exit", () => exit()),
        vscode.commands.registerCommand("porthole.tour.list", list),
        vscode.commands.registerCommand("porthole.tour.switch", switchTour),
        vscode.commands.registerCommand("porthole.tour.closeAll", closeAll),
        // Takes a tree node as well as a bare id, because that is what the
        // context menu passes.
        vscode.commands.registerCommand("porthole.tour.activate", (arg) =>
            activateTour(idOf(arg)),
        ),
        vscode.commands.registerCommand("porthole.tour.close", (arg) => close(idOf(arg))),
        vscode.commands.registerCommand("porthole.tour.jump", async (tourId, index) => {
            if (tourId && tourId !== activeTourId) await activateTour(tourId, index);
            else await goto(index);
        }),
        { dispose: clearDecorations },
    );

    void vscode.commands.executeCommand("setContext", "porthole.tourActive", false);
    void vscode.commands.executeCommand("setContext", "porthole.tourLibrary", false);
}

module.exports = {
    activate,
    // the library
    upsert,
    start,
    activateTour,
    close,
    closeAll,
    unload,
    adopt,
    getLibrary,
    getTour,
    activeComparison,
    tourComparison,
    updateRevisionStates,
    has,
    validateComparison,
    setPersistenceHandlers,
    republishAll,
    // the active tour
    exit,
    goto,
    step,
    getState,
    isActive,
    onDidChangeState,
};
