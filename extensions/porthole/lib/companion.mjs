// Talking to the porthole companion VS Code extension.
//
// Requests use the exact window's addressed inbox and a separately addressed
// acknowledgement. Updated peers add one stable logical operation identity
// across bounded delivery retries, so losing an ack does not repeat the effect.
//
// Older addressed companions still receive one legacy attempt:
//
//   write   ~/.copilot/porthole/inbox/<windowId>/<requestId>.json
//   poll    <tmp>/porthole/ack/<requestId>.json
//
// No socket, no port, no cross-window URI fallback.

import { performance } from "node:perf_hooks";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    watch,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir, uptime } from "node:os";
import { join } from "node:path";

import { config, copilotHome } from "./config.mjs";
import {
    companionSupportsRoute,
    companionSupportsSessionOwnedOperations,
} from "./capabilities.mjs";
import { connectedIdes } from "./editor.mjs";
import { classifyOwnership, sessionIdentity } from "./ownership.mjs";

const ROOT = join(tmpdir(), "porthole");
const REQ_DIR = join(ROOT, "req");
const ACK_DIR = join(ROOT, "ack");
// The ack poll starts tight and backs off. Almost every ack lands in the first
// few tens of milliseconds, so a small first interval is what actually decides
// how responsive a route feels; a fixed 10ms then spends the rest of a failing
// request doing a hundred pointless existsSync calls a second.
const POLL_MIN_MS = 2;
const POLL_MAX_MS = 50;
const POLL_GROWTH = 1.4;
const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
// Litter is bounded by MAX_AGE_MS, so sweeping on every single request buys
// nothing and costs a readdir plus a stat per leftover file each time.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A scheduled wait that overruns by more than this was the machine suspending
// or the event loop being frozen, not active time the companion could use.
const SUSPEND_THRESHOLD_MS = 5000;
const WINDOW_ID = /^[a-f0-9]{16}$/;
// Anything written before this machine last booted was written by a process
// that is definitively gone, whatever the pid says now.
const BOOT_SLACK_MS = 60 * 1000;
const SESSION_OPERATION_VERSION = 1;
const OPERATION_EXPIRY_ALLOWANCE_MS = 5000;
const RETRY_OFFSETS_MS = Object.freeze([250, 750]);

/**
 * When this machine booted, give or take.
 *
 * A pid probe alone cannot spot a presence file left by a hard power-off: after
 * a reboot the pid it names may have been handed to an unrelated process, and
 * an unelevated probe of one of those answers EPERM, which is deliberately read
 * as "alive". The stale record then never expires, and a window that reopens
 * the same Copilot session looks like a second live owner - so every route
 * refuses as ambiguous, permanently, with nothing to clear it.
 */
function bootedAt() {
    return Date.now() - uptime() * 1000;
}

function writtenBeforeBoot(info) {
    const written = Date.parse(info.updatedAt);
    if (!Number.isFinite(written)) return false; // no evidence; leave it alone
    return written < bootedAt() - BOOT_SLACK_MS;
}

const EXTENSION_ID = "lando-00.porthole-companion";

function inboxRoot() {
    return join(copilotHome(), "porthole", "inbox");
}

function ensureDirs() {
    mkdirSync(REQ_DIR, { recursive: true });
    mkdirSync(ACK_DIR, { recursive: true });
}

let lastSweptAt = 0;

/** Nothing here is read twice, so old files are just litter. */
function sweep({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastSweptAt < SWEEP_INTERVAL_MS) return;
    lastSweptAt = now;

    const cutoff = Date.now() - MAX_AGE_MS;
    for (const dir of [REQ_DIR, ACK_DIR]) {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const file = join(dir, entry);
            try {
                if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
            } catch {
                // Racing another sweep is fine.
            }
        }
    }
}

/**
 * Live companion windows, newest heartbeat first.
 *
 * Each window writes ~/.copilot/porthole/companion-<pid>.json while it runs and
 * deletes it on shutdown; a crashed window leaves one behind, so the pid is
 * probed rather than trusted.
 */
export function findCompanions() {
    const dir = join(copilotHome(), "porthole");
    if (!existsSync(dir)) return [];

    const found = [];
    let entries = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.startsWith("companion-") || !entry.endsWith(".json")) continue;
        const file = join(dir, entry);
        let info;
        try {
            info = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            continue;
        }
        if (!info.pid) continue;

        // Checked before the pid probe, because a recycled pid can make the
        // probe say "alive" about a process that died with the last boot.
        if (writtenBeforeBoot(info)) {
            rmSync(file, { force: true });
            if (WINDOW_ID.test(String(info.windowId || ""))) {
                rmSync(join(inboxRoot(), info.windowId), { recursive: true, force: true });
            }
            continue;
        }

        // ESRCH means the window is gone; EPERM means it exists but is not
        // ours to signal, which happens when one side runs elevated. Deleting
        // on EPERM would hide a perfectly healthy window.
        try {
            process.kill(info.pid, 0);
        } catch (err) {
            if (err.code !== "EPERM") {
                rmSync(file, { force: true }); // the window is gone
                if (WINDOW_ID.test(String(info.windowId || ""))) {
                    rmSync(join(inboxRoot(), info.windowId), { recursive: true, force: true });
                }
                continue;
            }
        }
        found.push({ ...info, file });
    }

    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function describeCandidate(companion) {
    return {
        windowId: companion.windowId || null,
        pid: companion.pid,
        appName: companion.appName,
        sessionId: companion.sessionId || null,
        sessionFolder: companion.sessionFolder || null,
        workspaceFolders: companion.workspaceFolders || [],
    };
}

/**
 * Orders the windows a session owns: primary first.
 *
 * The primary is the oldest, so the window a session started with stays the one
 * it answers in, and a window forced afterwards joins as a secondary rather
 * than displacing it. When the primary closes the next oldest simply becomes
 * primary - no election, no stored state, nothing to go stale.
 *
 * `startedAt` is fixed for an extension host's lifetime; `updatedAt` is not, so
 * it cannot be used here. A companion too old to publish `startedAt` sorts last
 * rather than winning by accident.
 */
function byAge(a, b) {
    const left = Date.parse(a.startedAt);
    const right = Date.parse(b.startedAt);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    if (Number.isFinite(left)) return -1;
    if (Number.isFinite(right)) return 1;
    return String(a.windowId || "").localeCompare(String(b.windowId || ""));
}

/**
 * Every window this session owns, primary first.
 *
 * Ownership is the session folder being open in the window, so this is the set
 * a visual route should reach.
 */
export function ownedCompanions(options = {}) {
    const expected = sessionIdentity({
        sessionId: options.sessionId,
        sessionPath: options.sessionPath,
    });
    if (!expected.sessionId && !expected.sessionPath) return [];
    const companions = options.companions || findCompanions();
    return companions
        .filter((companion) => classifyOwnership(companion, expected) === "owned")
        .sort(byAge);
}

/**
 * Selects one exact companion, or reports why choosing would be unsafe.
 *
 * Session identity beats repository identity. Two sessions can work in the
 * same repository, so a project-path match is only usable when it is unique.
 *
 * Several windows owned by the *same* session is no longer an error: ownership
 * is defined by which session folder is open in a window, and a session is
 * allowed to hold more than one. The oldest answers. Cross-session and
 * genuinely undecidable cases still refuse.
 */
export function chooseCompanion(companions, options = {}) {
    const expected = sessionIdentity({
        sessionId: options.sessionId,
        sessionPath: options.sessionPath,
    });
    const hasExpected = Boolean(expected.sessionId || expected.sessionPath);

    if (options.windowId) {
        const match = companions.find((c) => c.windowId === options.windowId);
        if (!match) {
            return {
                companion: null,
                reason: "unknown-window",
                windowId: options.windowId,
                candidates: companions.map(describeCandidate),
            };
        }
        if (!hasExpected) {
            return {
                companion: null,
                reason: "unknown-session",
                candidates: [describeCandidate(match)],
            };
        }

        const ownership = classifyOwnership(match, expected);
        const allowUnbound =
            ownership === "unbound" &&
            (options.adoptUnbound === true || options.inspectUnbound === true);
        return ownership === "owned" || allowUnbound
            ? { companion: match, reason: null, candidates: [], ownership }
            : {
                  companion: null,
                  reason: `ownership-${ownership}`,
                  candidates: [describeCandidate(match)],
              };
    }

    if (companions.length === 0) return { companion: null, reason: "absent", candidates: [] };
    const sessionMatches = companions
        .filter((companion) => classifyOwnership(companion, expected) === "owned")
        .sort(byAge);
    if (sessionMatches.length > 0) {
        return {
            companion: sessionMatches[0],
            reason: null,
            candidates: [],
            owned: sessionMatches,
        };
    }

    if (hasExpected) {
        return {
            companion: null,
            reason: "session-missing",
            candidates: companions.map(describeCandidate),
        };
    }

    return {
        companion: null,
        reason: "unknown-session",
        candidates: companions.map(describeCandidate),
    };
}

export function selectCompanion(options = {}) {
    return chooseCompanion(findCompanions(), options);
}

/** The one safe companion for this target, if any. */
export function findCompanion(contextPath, options = {}) {
    return selectCompanion({ ...options, contextPath }).companion;
}

/**
 * Why a window cannot be reached, or null when it can.
 *
 * The two halves only meet on a shared filesystem, and the evidence for that is
 * `tmpdir` and `copilotHome` - not where the window happens to be hosted.
 *
 * A non-null `remoteName` used to be refused outright, which was wrong in both
 * directions. The case it meant to catch - CLI on the host, editor attached to
 * a remote - never reaches here at all: that companion publishes its heartbeat
 * into the *remote's* `~/.copilot`, which this process cannot read, so it is
 * already `absent`. What the check actually caught was the correct setup, with
 * the CLI running inside the same WSL distribution, container or Codespace as
 * the editor. Those share every path, and were refused with advice to do the
 * thing the user was already doing.
 *
 * So `remoteName` now only explains a mismatch, rather than being one.
 */
function unreachable(companion) {
    const where = companion.remoteName ? ` (running in ${companion.remoteName})` : "";

    if (companion.tmpdir && !samePath(companion.tmpdir, tmpdir())) {
        return (
            `the VS Code window${where} uses a different temp directory ` +
            `(${companion.tmpdir}), so it cannot see this session's requests.`
        );
    }
    if (companion.copilotHome && !samePath(companion.copilotHome, copilotHome())) {
        return (
            `the VS Code window${where} uses a different Copilot home ` +
            `(${companion.copilotHome}). Set COPILOT_HOME to the same value in both.`
        );
    }
    return null;
}

function samePath(a, b) {
    return String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * Sends a request and waits for the companion's answer.
 *
 * Always resolves. `reason` says why it could not be done, so callers can fall
 * back to a plain `--goto` instead of claiming a success they cannot verify.
 */
/**
 * Routes that describe something to look at rather than change something.
 *
 * These are broadcast to every window the session owns, so a session working
 * across two windows sees its own annotations in both. Everything else - a
 * preview's Apply prompt, a workspace edit, a deletion, a query expecting one
 * answer - goes to the primary alone, because doing it twice is either
 * destructive or nonsense.
 */
const BROADCAST_ROUTES = new Set([
    "reveal",
    "",
    "annotate",
    "annotate-clear",
]);

export async function callCompanion(route, payload = null, options = {}) {
    const contextPath = options.contextPath || null;
    const configuredTimeout = options.timeoutMs ?? config().companionTimeoutMs;
    const timeoutMs = Number.isFinite(Number(configuredTimeout))
        ? Math.max(0, Number(configuredTimeout))
        : config().companionTimeoutMs;
    const wallStartedAt = Date.now();
    const deadline = createSharedDeadline(timeoutMs);

    const selected = selectCompanion({
        contextPath,
        sessionPath: options.sessionPath,
        sessionId: options.sessionId,
        windowId: options.windowId,
        adoptUnbound: options.adoptUnbound === true,
        inspectUnbound: options.inspectUnbound === true,
    });
    const companion = selected.companion;
    if (!companion) {
        if (selected.reason !== "absent") {
            const ownership = String(selected.reason || "").replace(/^ownership-/, "");
            const error =
                selected.reason === "unknown-window"
                    ? `the requested VS Code window '${options.windowId}' is no longer available`
                    : selected.reason === "unknown-session"
                      ? "this request has no verifiable Copilot session identity"
                      : selected.reason === "session-missing"
                        ? "no VS Code window is bound to this Copilot session"
                        : ownership === "unbound"
                          ? `the requested VS Code window '${options.windowId}' is unbound`
                          : ownership === "foreign"
                            ? `the requested VS Code window '${options.windowId}' belongs to another Copilot session`
                            : ownership === "conflicted"
                              ? `the requested VS Code window '${options.windowId}' has conflicting session bindings`
                              : `the requested VS Code window '${options.windowId}' has unknown session ownership`;
            return {
                ok: false,
                reason: selected.reason === "session-missing" ? "absent" : selected.reason,
                error,
                candidates: selected.candidates,
                ...(options.windowId
                    ? { windowId: options.windowId }
                    : {}),
            };
        }
        // Without a heartbeat there is nothing listening, and firing the URI
        // anyway would just burn the whole timeout before saying so.
        return {
            ok: false,
            reason: "absent",
            error: "no VS Code window with the porthole companion is running",
        };
    }

    if (
        options.adoptUnbound === true &&
        (route !== "workspace-add" || !options.windowId || selected.ownership !== "unbound")
    ) {
        return {
            ok: false,
            reason: "refused",
            error:
                "adopt-unbound is allowed only for workspace-add to an explicitly selected unbound window",
            windowId: companion.windowId || null,
            deliveryMode: companionSupportsSessionOwnedOperations(companion)
                ? "guarded"
                : "legacy-single-shot",
        };
    }
    if (
        options.inspectUnbound === true &&
        (route !== "ping" || !options.windowId || selected.ownership !== "unbound")
    ) {
        return {
            ok: false,
            reason: "refused",
            error:
                "unbound inspection is allowed only for ping to an explicitly selected unbound window",
            windowId: companion.windowId || null,
            deliveryMode: "legacy-single-shot",
        };
    }

    let payloadSnapshot;
    try {
        payloadSnapshot = JSON.parse(JSON.stringify(payload));
    } catch (error) {
        return {
            ok: false,
            reason: "error",
            error: `request payload could not be serialised: ${error.message}`,
            windowId: companion.windowId || null,
            deliveryMode: companionSupportsSessionOwnedOperations(companion)
                ? "guarded"
                : "legacy-single-shot",
        };
    }

    ensureDirs();
    sweep();

    const secondaries =
        !options.windowId && BROADCAST_ROUTES.has(route)
            ? (selected.owned || []).slice(1)
            : [];
    const targets = Object.freeze([companion, ...secondaries]);
    const expected = sessionIdentity({
        sessionId: options.sessionId,
        sessionPath: options.sessionPath,
    });
    const operationBase = Object.freeze({
        version: SESSION_OPERATION_VERSION,
        id: randomUUID(),
        createdAt: new Date(wallStartedAt).toISOString(),
        expiresAt: new Date(
            wallStartedAt + timeoutMs + OPERATION_EXPIRY_ALLOWANCE_MS,
        ).toISOString(),
        sessionId: expected.sessionId,
        sessionFolder: expected.sessionPath,
        admission: options.adoptUnbound === true ? "adopt-unbound" : "owned",
    });

    const outcomes = await Promise.all(
        targets.map((target) =>
            deliverTo(target, route, payloadSnapshot, {
                deadline,
                expected,
                operationBase,
                forceLegacy: options.inspectUnbound === true,
            }),
        ),
    );
    const result = outcomes[0];
    if (outcomes.length > 1) {
        result.alsoShownIn = outcomes.slice(1).map(secondaryOutcome);
    }

    return result;
}

/** One request to one named window. */
async function deliverTo(
    companion,
    route,
    payload,
    { deadline, expected, operationBase, forceLegacy = false },
) {
    const guarded =
        companionSupportsSessionOwnedOperations(companion) && !forceLegacy;
    const deliveryMode = guarded ? "guarded" : "legacy-single-shot";
    const targetMetadata = {
        windowId: companion.windowId || null,
        targetStartedAt: companion.startedAt || null,
        deliveryMode,
        operationId: guarded ? operationBase.id : null,
    };

    // Checked before firing: an unreachable pairing would otherwise burn the
    // whole timeout and then report the wrong cause.
    const blocked = unreachable(companion);
    if (blocked) return { ok: false, reason: "refused", error: blocked, ...targetMetadata };

    const capability = companionSupportsRoute(companion, route);
    if (!capability.ok) {
        return {
            ok: false,
            reason: "incompatible",
            error: capability.error,
            missingCapability: capability.required,
            companionVersion: companion.version || null,
            ...targetMetadata,
        };
    }
    if (
        Array.isArray(companion.capabilities) &&
        !companion.capabilities.includes("transport:addressed-inbox")
    ) {
        return {
            ok: false,
            reason: "incompatible",
            error:
                "this operation requires companion capability 'transport:addressed-inbox'. " +
                "Update the porthole companion and open a new VS Code window.",
            missingCapability: "transport:addressed-inbox",
            companionVersion: companion.version || null,
            ...targetMetadata,
        };
    }

    if (!WINDOW_ID.test(String(companion.windowId || ""))) {
        return {
            ok: false,
            reason: "incompatible",
            error:
                "this companion cannot accept exact-window addressed delivery; update it and open a new VS Code window",
            ...targetMetadata,
        };
    }

    if (!guarded) {
        return deliverLegacy(companion, route, payload, {
            deadline,
            targetMetadata,
            legacyReason: forceLegacy ? "unbound-inspection" : null,
        });
    }
    if (!expected.sessionId || !expected.sessionPath) {
        return {
            ok: false,
            reason: "refused",
            error: "guarded delivery requires the source Copilot session id and folder",
            ...targetMetadata,
        };
    }
    if (!Number.isFinite(Date.parse(companion.startedAt))) {
        return {
            ok: false,
            reason: "incompatible",
            error:
                "the companion advertises guarded delivery without a valid host incarnation",
            ...targetMetadata,
        };
    }

    const operation = Object.freeze({
        ...operationBase,
        targetWindowId: companion.windowId,
        targetStartedAt: companion.startedAt,
    });
    return deliverGuarded(companion, route, payload, {
        deadline,
        expected,
        operation,
        targetMetadata,
    });
}

function secondaryOutcome(result) {
    return {
        windowId: result.windowId || null,
        ok: Boolean(result.ok),
        error: result.ok ? undefined : result.error,
        reason: result.ok ? undefined : result.reason,
        deliveryMode: result.deliveryMode,
        operationId: result.operationId || null,
        disposition: result.disposition,
        mayHaveExecuted: result.mayHaveExecuted,
    };
}

/**
 * Tells the addressed window that this request no longer has anyone listening.
 *
 * Best effort: if the marker cannot be written the behaviour is simply what it
 * was before, so this must never turn a timeout into a thrown error.
 */
function abandonInbox(windowId, requestId) {
    if (!WINDOW_ID.test(String(windowId || ""))) return;
    try {
        const file = join(inboxRoot(), windowId, `${requestId}.abandoned`);
        const tmp = `${file}.tmp`;
        writeFileSync(
            tmp,
            JSON.stringify({ requestId, abandonedAt: new Date().toISOString() }),
            { encoding: "utf8", mode: 0o600 },
        );
        renameSync(tmp, file);
    } catch {
        // The window may already be gone, which needs no marker.
    }
}

function writeInbox(windowId, request) {
    try {
        const dir = join(inboxRoot(), windowId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, `${request.requestId}.json`);
        const tmp = `${file}.tmp`;
        const raw = JSON.stringify(request);
        if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
            return { error: "request exceeded the 6 MiB transport limit", file: null };
        }
        writeFileSync(tmp, raw, { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, file);
        return { error: null, file };
    } catch (err) {
        return { error: err.message, file: null };
    }
}

async function deliverLegacy(
    companion,
    route,
    payload,
    { deadline, targetMetadata, legacyReason = null },
) {
    const requestId = newRequestId();
    const written = writeInbox(companion.windowId, {
        requestId,
        route,
        payload,
        ...(legacyReason ? { legacyReason } : {}),
    });
    if (written.error) {
        return {
            ok: false,
            reason: "error",
            error: `could not reach the editor: ${written.error}`,
            requestId,
            operationId: null,
            ...targetMetadata,
        };
    }
    const attempts = [{ requestId, file: written.file, settled: false }];
    const outcome = await waitForAttemptOutcome({
        attempts,
        deadline,
        validateAck: validateLegacyAck,
    });
    if (!outcome.ack) {
        abandonAttempts(companion.windowId, attempts);
        return unconfirmedResult({
            attempts,
            deadline,
            operationId: null,
            targetMetadata,
            details: outcome.errors,
        });
    }

    abandonAttempts(companion.windowId, attempts, outcome.attempt.requestId);
    const result = {
        ...outcome.ack,
        requestId: outcome.attempt.requestId,
        operationId: null,
        disposition: outcome.ack.disposition || "executed",
        ...targetMetadata,
    };
    return result.ok ? result : { ...result, reason: result.reason || "refused" };
}

async function deliverGuarded(
    companion,
    route,
    payload,
    { deadline, expected, operation, targetMetadata },
) {
    const attempts = [];
    const initial = publishGuardedAttempt(companion, route, payload, operation);
    if (initial.error) {
        return {
            ok: false,
            reason: "error",
            error: `could not reach the editor: ${initial.error}`,
            requestId: initial.requestId,
            operationId: operation.id,
            ...targetMetadata,
        };
    }
    attempts.push(initial.attempt);

    const outcome = await waitForAttemptOutcome({
        attempts,
        deadline,
        retryOffsets: RETRY_OFFSETS_MS,
        retry: () => {
            const blocked = retryRefusal(companion, expected, operation.admission);
            if (blocked) return { error: blocked };
            const published = publishGuardedAttempt(companion, route, payload, operation);
            if (published.error) return { error: published.error };
            attempts.push(published.attempt);
            return { attempt: published.attempt };
        },
        validateAck: (ack, attempt) => validateGuardedAck(ack, attempt, operation),
    });

    if (!outcome.ack) {
        abandonAttempts(companion.windowId, attempts);
        return unconfirmedResult({
            attempts,
            deadline,
            operationId: operation.id,
            targetMetadata,
            details: outcome.errors,
        });
    }

    abandonAttempts(companion.windowId, attempts, outcome.attempt.requestId);
    return outcome.ack.ok
        ? outcome.ack
        : { ...outcome.ack, reason: outcome.ack.reason || "refused" };
}

function publishGuardedAttempt(companion, route, payload, operation) {
    const requestId = newRequestId();
    const written = writeInbox(companion.windowId, {
        requestId,
        operation,
        route,
        payload,
    });
    return written.error
        ? { error: written.error, requestId }
        : {
              error: null,
              requestId,
              attempt: { requestId, file: written.file, settled: false },
          };
}

function newRequestId() {
    return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function retryRefusal(companion, expected, admission) {
    const current = findCompanions().find(
        (candidate) => candidate.windowId === companion.windowId,
    );
    if (!current) return "the pinned companion host is no longer running";
    if (current.startedAt !== companion.startedAt) {
        return "the pinned companion host was replaced; the operation was not replayed";
    }
    if (!companionSupportsSessionOwnedOperations(current)) {
        return "the pinned companion host no longer advertises guarded delivery";
    }
    const blocked = unreachable(current);
    if (blocked) return blocked;

    const ownership = classifyOwnership(current, expected);
    const allowed =
        ownership === "owned" ||
        (admission === "adopt-unbound" && ownership === "unbound");
    return allowed
        ? null
        : `the pinned target's session ownership changed to '${ownership}'`;
}

function validateLegacyAck(ack) {
    if (!ack || typeof ack !== "object" || Array.isArray(ack)) {
        return "the companion acknowledgement was not a JSON object";
    }
    if (typeof ack.ok !== "boolean") {
        return "the companion acknowledgement did not contain an outcome";
    }
    return null;
}

function validateGuardedAck(ack, attempt, operation) {
    const legacyError = validateLegacyAck(ack);
    if (legacyError) return legacyError;
    const expected = {
        requestId: attempt.requestId,
        operationId: operation.id,
        windowId: operation.targetWindowId,
        targetStartedAt: operation.targetStartedAt,
        deliveryMode: "guarded",
    };
    for (const [key, value] of Object.entries(expected)) {
        if (ack[key] !== value) {
            return `guarded acknowledgement ${key} did not match the pinned operation`;
        }
    }
    if (!["executed", "joined", "replayed", "rejected"].includes(ack.disposition)) {
        return "guarded acknowledgement disposition was missing or invalid";
    }
    return null;
}

function takeAck(attempt) {
    const file = join(ACK_DIR, `${attempt.requestId}.json`);
    if (!existsSync(file)) return { found: false };
    try {
        const ack = JSON.parse(readFileSync(file, "utf8"));
        rmSync(file, { force: true });
        return { found: true, ack };
    } catch {
        return { found: false };
    }
}

async function waitForAttemptOutcome({
    attempts,
    deadline,
    retryOffsets = [],
    retry = null,
    validateAck,
}) {
    const errors = [];
    const startedAt = deadline.activeElapsed();
    let retryIndex = 0;
    let wake = null;
    let watcher = null;
    try {
        watcher = watch(ACK_DIR, { persistent: false }, (_event, changed) => {
            // Some platforms report no filename; waking for those is cheap.
            if (
                !changed ||
                attempts.some((attempt) => String(changed).startsWith(attempt.requestId))
            ) {
                wake?.();
            }
        });
        if (typeof watcher.on === "function") watcher.on("error", () => {});
    } catch {
        watcher = null; // polling alone still answers, just less promptly
    }

    try {
        let interval = POLL_MIN_MS;
        for (;;) {
            for (const attempt of attempts) {
                if (attempt.settled) continue;
                const found = takeAck(attempt);
                if (!found.found) continue;
                attempt.settled = true;
                const invalid = validateAck(found.ack, attempt);
                if (!invalid) return { ack: found.ack, attempt, errors };
                errors.push(invalid);
                interval = POLL_MIN_MS;
            }

            const elapsed = deadline.activeElapsed() - startedAt;
            while (
                retry &&
                retryIndex < retryOffsets.length &&
                elapsed >= retryOffsets[retryIndex] &&
                deadline.remaining() > 0
            ) {
                const retried = retry();
                if (retried.error) errors.push(retried.error);
                retryIndex += 1;
            }

            const remaining = deadline.remaining();
            if (remaining <= 0) return { ack: null, attempt: null, errors };

            const nextRetry =
                retry && retryIndex < retryOffsets.length
                    ? Math.max(0, retryOffsets[retryIndex] - elapsed)
                    : Number.POSITIVE_INFINITY;
            const nap = Math.min(interval, nextRetry, remaining);
            await deadline.sleep(nap, (resume) => {
                wake = resume;
            });
            wake = null;
            interval = Math.min(interval * POLL_GROWTH, POLL_MAX_MS);
        }
    } finally {
        wake = null;
        try {
            if (watcher) watcher.close();
        } catch {
            // Already closed.
        }
    }
}

function abandonAttempts(windowId, attempts, winnerRequestId = null) {
    for (const attempt of attempts) {
        if (attempt.requestId === winnerRequestId || attempt.settled) continue;
        abandonInbox(windowId, attempt.requestId);
        if (attempt.file) rmSync(attempt.file, { force: true });
    }
}

function unconfirmedResult({
    attempts,
    deadline,
    operationId,
    targetMetadata,
    details = [],
}) {
    const detail = details.length ? ` Last transport detail: ${details[details.length - 1]}.` : "";
    return {
        ok: false,
        reason: "unconfirmed",
        error:
            `the companion did not confirm the operation within ${deadline.budgetMs}ms.` +
            detail,
        mayHaveExecuted: attempts.length > 0,
        requestId: attempts[attempts.length - 1]?.requestId || null,
        operationId,
        attempts: attempts.length,
        disposition: null,
        ...targetMetadata,
    };
}

function createSharedDeadline(budgetMs) {
    const startedAt = performance.now();
    const suspensions = [];
    let activeFloor = 0;

    function addSuspension(start, end) {
        if (end <= start) return;
        let left = start;
        let right = end;
        const merged = [];
        let inserted = false;
        for (const interval of suspensions) {
            if (interval.end < left) {
                merged.push(interval);
            } else if (right < interval.start) {
                if (!inserted) {
                    merged.push({ start: left, end: right });
                    inserted = true;
                }
                merged.push(interval);
            } else {
                left = Math.min(left, interval.start);
                right = Math.max(right, interval.end);
            }
        }
        if (!inserted) merged.push({ start: left, end: right });
        suspensions.splice(0, suspensions.length, ...merged);
    }

    function activeElapsed() {
        const now = performance.now();
        let suspended = 0;
        for (const interval of suspensions) {
            const end = Math.min(interval.end, now);
            if (end > interval.start) suspended += end - interval.start;
        }
        const observed = Math.max(0, now - startedAt - suspended);
        activeFloor = Math.max(activeFloor, observed);
        return activeFloor;
    }

    async function sleep(ms, register) {
        const scheduled = Math.max(0, ms);
        const before = performance.now();
        await napUntilWoken(scheduled, register);
        const after = performance.now();
        if (after - before > scheduled + SUSPEND_THRESHOLD_MS) {
            addSuspension(before + scheduled, after);
        }
    }

    return {
        budgetMs,
        activeElapsed,
        remaining: () => Math.max(0, budgetMs - activeElapsed()),
        sleep,
    };
}

/** Sleeps for `ms`, or until `register`'s callback is invoked, whichever is first. */
function napUntilWoken(ms, register) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        register(finish);
    });
}

/** Human-readable reason a companion call failed, for logging. */
export function explain(result) {
    if (result.ok) return "";
    if (result.reason === "ambiguous") {
        return (
            `${result.error}. Call porthole_windows and ask the user which window they mean; ` +
            "do not guess."
        );
    }
    if (result.reason === "unknown-window") return result.error;
    if (result.reason === "absent") {
        if (/bound to this Copilot session/i.test(result.error || "")) {
            return `${result.error}. Run /cops or ask to open this session in a new window.`;
        }
        return explainAbsent();
    }
    if (result.reason === "timeout") {
        // Deliberately does not delete the presence file it fired at. Deleting
        // it looked like tidy self-healing and was a trap: the request path
        // returns early when there is no presence file, so a window that
        // answered one poll interval late would never be sent another request,
        // and could never republish. A live window, unreachable forever.
        //
        // Nothing needs deleting anyway. Firing at a stale record launches the
        // editor, which then publishes a fresh record of its own with a newer
        // timestamp - and readers prefer the newest. The stale one is outranked
        // rather than obeyed, and goes when its pid does.
        return (
            `${result.error}. Either the window is busy, or that record is left over from ` +
            "a window that no longer exists - in which case the editor is starting now. Try again."
        );
    }
    if (result.reason === "unconfirmed") {
        return (
            `${result.error}. The action may already have executed; confirm its outcome before ` +
            "issuing it as a new operation."
        );
    }
    return result.error || "the companion refused the request";
}

/**
 * Where editors keep installed extensions.
 *
 * All the flavours this plugin can drive, not just VS Code - editor.mjs
 * launches Cursor and Windsurf too, and telling one of their users to run
 * `code --install-extension` sends them to install into a different editor,
 * which changes nothing.
 */
function extensionDirs() {
    const home = homedir();
    const dirs = [
        join(home, ".vscode", "extensions"),
        join(home, ".vscode-insiders", "extensions"),
        join(home, ".cursor", "extensions"),
        join(home, ".windsurf", "extensions"),
    ];
    if (process.env.VSCODE_EXTENSIONS) dirs.unshift(process.env.VSCODE_EXTENSIONS);
    return dirs;
}

/**
 * Whether the companion is installed on disk, regardless of whether it is
 * currently running.
 *
 * A positive answer is trustworthy; a negative one is only probably right,
 * since `--extensions-dir` and portable installs put it somewhere this cannot
 * see. The message below is hedged to match.
 */
export function isCompanionInstalled() {
    for (const dir of extensionDirs()) {
        let entries = [];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        if (entries.some((e) => e.toLowerCase().startsWith(`${EXTENSION_ID}-`))) return true;
    }
    return false;
}

/**
 * Why nothing answered.
 *
 * "No presence file" has three quite different causes and they need three
 * different answers. Telling someone to install an extension they already have
 * - which is what this used to do - sends them to check the one thing that is
 * fine, and the instruction it gave was the *developer* one at that.
 */
function explainAbsent() {
    if (!isCompanionInstalled()) {
        return (
            "could not find the porthole companion extension in the usual place.\n" +
            "  If it is not installed:  code --install-extension Lando-00.porthole-companion\n" +
            "  (or code-insiders / cursor / windsurf), then open a new window."
        );
    }

    // Installed. So either no window is running it, or one is and it is not
    // answering - nearly always a window that predates the install, or a
    // workspace the user has not trusted yet.
    //
    // `connectedIdes()` answers a near-but-not-identical question: which
    // editors are attached to Copilot CLI, not which are running the companion.
    // Worded as the hint it is, rather than as a claim about VS Code.
    const ides = connectedIdes();
    if (ides.length === 0) {
        return (
            "the porthole companion is installed, but no window is reporting in.\n" +
            "  If your editor is not open, /cops will open it.\n" +
            "  If it is open, it was probably started before the extension was installed -\n" +
            "  extension versions are resolved when a window loads, so open a NEW window."
        );
    }

    const names = [...new Set(ides.map((i) => i.ideName).filter(Boolean))].join(", ");
    return (
        `the porthole companion is installed and Copilot is connected to ${names || "an editor"}, ` +
        "but the companion is not answering.\n" +
        "  Extension versions are resolved when a window loads, so a window opened before\n" +
        "  the install is still running the old one - open a NEW window.\n" +
        "  If your editor is asking whether you trust this workspace, it disables every\n" +
        "  extension until you say yes."
    );
}
