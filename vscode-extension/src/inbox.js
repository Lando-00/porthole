// Exact-window request inbox.
//
// The CLI writes <windowId>/<requestId>.json.tmp and atomically renames it
// into ~/.copilot/porthole/inbox/<windowId>/. The companion watches only its
// own directory, claims each request with another atomic rename, and hands the
// request to extension.js. URI and inbox delivery share route dispatch, while
// this addressed path owns guarded admission and per-attempt acknowledgements.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const transport = require("./transport");
const { createOperationHost, createExecutionBudget } = require("./operations");
const { diag } = require("./log");

const WINDOW_ID_RE = /^[a-f0-9]{16}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROUTE_RE = /^[A-Za-z0-9-]{0,64}$/;
// Preview requests carry complete proposed file contents. Keep a hard bound,
// but make it large enough for the preview module's documented 5 MB payload.
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const PROCESSING = ".processing";
const ABANDONED = ".abandoned";
// A marker for a request the window never claimed has nothing to cancel, so it
// is swept rather than kept. Comfortably longer than any route's timeout.
const ABANDONED_TTL_MS = 5 * 60 * 1000;
// A long-running route must not stop the next request being claimed, but an
// unbounded fan-out would let a stuck window accumulate work without limit.
const MAX_IN_FLIGHT = 8;
// fs.watch is the fast path, not the only path. It drops events on network and
// synced filesystems, and a watcher that errors once is never re-armed - which
// would silently strand every request to this window. Every other channel in
// porthole already polls as a backstop; this one now does too.
const FALLBACK_POLL_MS = 1000;

const active = new Set();

function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), ".copilot");
}

function inboxRoot() {
    return path.join(copilotHome(), "porthole", "inbox");
}

function assertWindowId(windowId) {
    if (!WINDOW_ID_RE.test(String(windowId))) {
        throw new TypeError("invalid porthole window id");
    }
    return String(windowId);
}

function isValidWindowId(windowId) {
    return WINDOW_ID_RE.test(String(windowId));
}

function isValidRequestId(requestId) {
    return REQUEST_ID_RE.test(String(requestId));
}

function isInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    const root = `${fold(parentPath)}${path.sep}`;
    const candidate = fold(childPath);
    return candidate !== fold(parentPath) && candidate.startsWith(root);
}

function childPath(parent, name) {
    const child = path.join(parent, name);
    if (!isInside(parent, child)) throw new Error("path escaped the porthole inbox");
    return child;
}

function makeOwnerOnly(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(dir, 0o700);
    } catch {
        // Windows does not expose POSIX mode bits; the per-user home is still
        // the trust boundary there.
    }

    if (typeof process.getuid === "function") {
        const stat = fs.statSync(dir);
        if (stat.uid !== process.getuid()) {
            throw new Error(`refusing inbox owned by uid ${stat.uid}`);
        }
    }
}

function prepare(windowId) {
    const id = assertWindowId(windowId);
    const root = inboxRoot();
    makeOwnerOnly(root);

    const dir = childPath(root, id);
    makeOwnerOnly(dir);

    const processing = childPath(dir, PROCESSING);
    makeOwnerOnly(processing);

    return { id, root, dir, processing };
}

function entryRequestId(entry) {
    if (!entry.endsWith(".json")) return null;
    const requestId = entry.slice(0, -".json".length);
    return isValidRequestId(requestId) ? requestId : null;
}

function discardInvalidEntry(dir, entry) {
    try {
        const file = childPath(dir, entry);
        const stat = fs.lstatSync(file);
        if (stat.isFile() || stat.isSymbolicLink()) fs.rmSync(file, { force: true });
    } catch {
        // A hostile or racing entry is not allowed to break the watcher.
    }
}

function invalid(error, details = {}) {
    return { request: null, error, ...details };
}

function readRequest(file, fileRequestId) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch {
        return invalid("request file was missing");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        return invalid("request file was not a regular file");
    }
    if (stat.size > MAX_REQUEST_BYTES) {
        return invalid("request was too large");
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return invalid("request was not valid JSON");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return invalid("request was not a JSON object");
    }
    const guarded = Object.prototype.hasOwnProperty.call(parsed, "operation");
    const operationId =
        guarded && parsed.operation && typeof parsed.operation.id === "string"
            ? parsed.operation.id
            : null;
    if (!isValidRequestId(parsed.requestId)) {
        return invalid("requestId was missing or invalid", { guarded, operationId });
    }
    if (parsed.requestId !== fileRequestId) {
        return invalid("requestId did not match its filename", { guarded, operationId });
    }
    if (typeof parsed.route !== "string" || !ROUTE_RE.test(parsed.route)) {
        return invalid("route was missing or invalid", { guarded, operationId });
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "payload")) {
        return invalid("payload was missing", { guarded, operationId });
    }

    return {
        request: {
            requestId: parsed.requestId,
            route: parsed.route,
            payload: parsed.payload,
            ...(typeof parsed.legacyReason === "string"
                ? { legacyReason: parsed.legacyReason }
                : {}),
            ...(guarded ? { operation: parsed.operation } : {}),
        },
        error: null,
        guarded,
        operationId,
    };
}

/**
 * Claims one request and starts handling it.
 *
 * Claiming is synchronous and handling is not awaited here, so a route that
 * legitimately takes a long time cannot hold up the queue behind it. That is
 * not hypothetical: `preview` parks on an Apply/Cancel notification until the
 * user answers it, and while it did so every other request to this window went
 * unclaimed and unacked until the CLI gave up on it - one ignored toast made a
 * perfectly healthy window look dead, `ping` included.
 */
function consume(state, entry) {
    const requestId = entryRequestId(entry);
    if (!requestId) {
        discardInvalidEntry(state.dir, entry);
        return;
    }

    let claimed;
    try {
        const source = childPath(state.dir, entry);
        claimed = childPath(state.processing, entry);
        fs.renameSync(source, claimed);
    } catch {
        // Another scan or process claimed it, or the file disappeared.
        return;
    }

    if (isAbandoned(state, requestId)) {
        clearAbandoned(state, requestId);
        try {
            fs.rmSync(claimed, { force: true });
        } catch {
            // Deactivation may have removed the inbox already.
        }
        diag(`porthole skipped ${requestId}: the CLI stopped waiting for it`);
        return;
    }

    const parsed = readRequest(claimed, requestId);
    if (parsed.error) {
        state.writeAck(requestId, {
            ok: false,
            reason: parsed.guarded ? "invalid-operation" : "invalid-request",
            error: parsed.error,
            requestId,
            operationId: parsed.operationId || null,
            windowId: state.id,
            targetStartedAt: state.startedAt,
            deliveryMode: parsed.guarded ? "guarded" : "legacy-single-shot",
            disposition: "rejected",
        });
        finishClaim(state, claimed);
        return;
    }

    if (parsed.guarded) {
        void handleGuarded(state, parsed.request).finally(() => {
            finishClaim(state, claimed);
        });
        return;
    }

    const releaseExecution = state.executionBudget.acquire();
    if (!releaseExecution) {
        try {
            fs.renameSync(claimed, childPath(state.dir, entry));
        } catch {
            state.writeAck(requestId, {
                ok: false,
                reason: "busy",
                error: "the companion execution budget is full",
                requestId,
                operationId: null,
                windowId: state.id,
                targetStartedAt: state.startedAt,
                deliveryMode: "legacy-single-shot",
                disposition: "rejected",
            });
            finishClaim(state, claimed);
        }
        return;
    }

    void handleLegacy(state, parsed.request).finally(() => {
        releaseExecution();
        finishClaim(state, claimed);
    });
}

/**
 * Whether the CLI gave up on this request before we got to it.
 *
 * Checked after the claim, because the claim is what the CLI cannot undo: it
 * removes the pending file on timeout, but a rename that has already happened
 * means the file it removes is not the file we hold. Without this the route
 * would run after the model had been told the window never answered - and the
 * model, having retried, would get two previews, two workspace edits, two of
 * whatever the route does.
 */
function isAbandoned(state, requestId) {
    try {
        return fs.existsSync(childPath(state.dir, `${requestId}${ABANDONED}`));
    } catch {
        return false;
    }
}

function clearAbandoned(state, requestId) {
    try {
        fs.rmSync(childPath(state.dir, `${requestId}${ABANDONED}`), { force: true });
    } catch {
        // Deactivation may have removed the inbox already.
    }
}

/** Drops a marker whose request was never claimed and never will be. */
function sweepAbandoned(state, entry) {
    const requestId = entry.slice(0, -ABANDONED.length);
    if (!isValidRequestId(requestId)) {
        discardInvalidEntry(state.dir, entry);
        return;
    }
    try {
        const file = childPath(state.dir, entry);
        if (Date.now() - fs.statSync(file).mtimeMs > ABANDONED_TTL_MS) {
            fs.rmSync(file, { force: true });
        }
    } catch {
        // Racing our own sweep is fine.
    }
}

function finishClaim(state, claimed) {
    try {
        fs.rmSync(claimed, { force: true });
    } catch {
        // Deactivation may have removed the inbox already.
    }
    schedule(state);
}

function normaliseLegacyResult(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {
              ok: false,
              error: "route returned no result",
              mayHaveExecuted: true,
          };
}

async function handleLegacy(state, request) {
    let result;
    try {
        result = normaliseLegacyResult(
            await state.onRequest(request, {
                deliveryMode: "legacy-single-shot",
                legacyReason: request.legacyReason || null,
            }),
        );
    } catch (error) {
        result = {
            ok: false,
            error: error?.message || String(error),
            mayHaveExecuted: true,
        };
    }
    state.writeAck(request.requestId, {
        ...result,
        requestId: request.requestId,
        operationId: null,
        windowId: state.id,
        targetStartedAt: state.startedAt,
        deliveryMode: "legacy-single-shot",
        disposition: "executed",
    });
}

async function handleGuarded(state, request) {
    if (!state.operationHost) {
        state.writeAck(request.requestId, {
            ok: false,
            reason: "invalid-operation",
            error: "guarded operation admission is unavailable",
            requestId: request.requestId,
            operationId:
                request.operation && typeof request.operation.id === "string"
                    ? request.operation.id
                    : null,
            windowId: state.id,
            targetStartedAt: state.startedAt,
            deliveryMode: "guarded",
            disposition: "rejected",
        });
        return;
    }

    let result;
    try {
        result = await state.operationHost.submit(request);
    } catch (error) {
        result = {
            ok: false,
            reason: "operation-error",
            error: error?.message || String(error),
            mayHaveExecuted: true,
            requestId: request.requestId,
            operationId:
                request.operation && typeof request.operation.id === "string"
                    ? request.operation.id
                    : null,
            windowId: state.id,
            targetStartedAt: state.startedAt,
            deliveryMode: "guarded",
            disposition: "rejected",
        };
    }
    state.writeAck(request.requestId, result);
}

function entryMightBeGuarded(state, entry) {
    try {
        const file = childPath(state.dir, entry);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REQUEST_BYTES) {
            return true;
        }
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.prototype.hasOwnProperty.call(parsed, "operation")
        );
    } catch {
        return true;
    }
}

function scan(state) {
    let entries;
    try {
        entries = fs.readdirSync(state.dir);
    } catch {
        return;
    }

    try {
        state.operationHost?.maintain();
    } catch (error) {
        diag(`porthole operation maintenance failed: ${error.message}`);
    }

    for (const entry of entries) {
        if (state.stopped) return;
        if (entry.endsWith(ABANDONED)) {
            sweepAbandoned(state, entry);
            continue;
        }
        if (!entry.endsWith(".json")) continue;
        if (
            state.executionBudget.active >= state.executionBudget.limit &&
            !entryMightBeGuarded(state, entry)
        ) {
            continue;
        }
        consume(state, entry);
    }
}

function schedule(state) {
    if (!active.has(state) || state.stopped) return;
    state.scanRequested = true;
    if (state.scanning) return;

    state.scanning = true;
    void (async () => {
        try {
            while (state.scanRequested && !state.stopped) {
                state.scanRequested = false;
                scan(state);
                // Yield, so a watcher event that arrives mid-pass is folded in
                // rather than starting a second overlapping loop.
                await Promise.resolve();
            }
        } catch (err) {
            diag(`porthole inbox scan failed: ${err.message}`);
        } finally {
            state.scanning = false;
            if (state.scanRequested && !state.stopped) schedule(state);
        }
    })();
}

function start(windowId, onRequest, options = {}) {
    if (typeof onRequest !== "function") throw new TypeError("inbox handler is required");

    let paths;
    try {
        paths = prepare(windowId);
    } catch (err) {
        diag(`porthole inbox unavailable: ${err.message}`);
        return { dispose() {} };
    }

    let operationHost = options.operationHost || null;
    const executionBudget = operationHost?.executionBudget || options.executionBudget ||
        createExecutionBudget(options.operationOptions?.maxExecutions || MAX_IN_FLIGHT);
    if (!operationHost && options.startedAt && typeof options.inspectOwnership === "function") {
        try {
            operationHost = createOperationHost({
                windowId: paths.id,
                startedAt: options.startedAt,
                inspectOwnership: options.inspectOwnership,
                execute: (request) => onRequest(request, { deliveryMode: "guarded" }),
                ...(options.operationOptions || {}),
                executionBudget,
            });
        } catch (error) {
            diag(`porthole guarded operation host unavailable: ${error.message}`);
        }
    }

    const state = {
        ...paths,
        onRequest,
        writeAck: options.writeAck || transport.writeAck,
        startedAt: options.startedAt || null,
        operationHost,
        executionBudget,
        watcher: null,
        poller: null,
        scanRequested: false,
        scanning: false,
        stopped: false,
    };
    active.add(state);

    try {
        // Watch first, then scan. That closes the race where a request arrives
        // between an activation scan and watcher registration.
        state.watcher = fs.watch(
            state.dir,
            { persistent: false },
            () => schedule(state),
        );
        if (typeof state.watcher.on === "function") {
            state.watcher.on("error", (err) => {
                // Deliberately not fatal: the poll below is what keeps this
                // window reachable once the watcher has given up.
                diag(`porthole inbox watcher failed: ${err.message}`);
            });
        }
    } catch (err) {
        diag(`porthole inbox watcher unavailable: ${err.message}`);
    }

    state.poller = setInterval(() => schedule(state), FALLBACK_POLL_MS);
    if (typeof state.poller.unref === "function") state.poller.unref();

    // Handles requests written before the extension host activated.
    schedule(state);
    return { dispose: () => stop(state) };
}

function stop(expected = null) {
    if (!expected) {
        for (const state of [...active]) stop(state);
        return;
    }
    const state = expected;
    if (!active.has(state)) return;

    state.stopped = true;
    active.delete(state);
    try {
        if (state.watcher) state.watcher.close();
    } catch {
        // Already closed.
    }
    if (state.poller) clearInterval(state.poller);
    state.poller = null;

    // Only this host's window directory is removed. Never sweep the inbox
    // root or another window's directory during deactivation.
    try {
        fs.rmSync(state.dir, { recursive: true, force: true });
    } catch (err) {
        diag(`porthole inbox cleanup failed: ${err.message}`);
    }
}

function inboxDir(windowId) {
    return childPath(inboxRoot(), assertWindowId(windowId));
}

module.exports = {
    start,
    stop,
    inboxRoot,
    inboxDir,
    isValidWindowId,
    isValidRequestId,
};
