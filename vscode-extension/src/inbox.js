// Exact-window request inbox.
//
// The CLI writes <windowId>/<requestId>.json.tmp and atomically renames it
// into ~/.copilot/porthole/inbox/<windowId>/. The companion watches only its
// own directory, claims each request with another atomic rename, and hands the
// request to extension.js. URI and inbox delivery therefore share one
// dispatcher and one ack path.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const transport = require("./transport");
const { diag } = require("./log");

const WINDOW_ID_RE = /^[a-f0-9]{16}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROUTE_RE = /^[A-Za-z0-9-]{0,64}$/;
// Preview requests carry complete proposed file contents. Keep a hard bound,
// but make it large enough for the preview module's documented 5 MB payload.
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const PROCESSING = ".processing";
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

function invalid(requestId, error) {
    transport.writeAck(requestId, { ok: false, error });
    return null;
}

function readRequest(file, fileRequestId) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch {
        return invalid(fileRequestId, "request file was missing");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        return invalid(fileRequestId, "request file was not a regular file");
    }
    if (stat.size > MAX_REQUEST_BYTES) {
        return invalid(fileRequestId, "request was too large");
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return invalid(fileRequestId, "request was not valid JSON");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return invalid(fileRequestId, "request was not a JSON object");
    }
    if (!isValidRequestId(parsed.requestId)) {
        return invalid(fileRequestId, "requestId was missing or invalid");
    }
    if (parsed.requestId !== fileRequestId) {
        return invalid(fileRequestId, "requestId did not match its filename");
    }
    if (typeof parsed.route !== "string" || !ROUTE_RE.test(parsed.route)) {
        return invalid(fileRequestId, "route was missing or invalid");
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "payload")) {
        return invalid(fileRequestId, "payload was missing");
    }

    return {
        requestId: parsed.requestId,
        route: parsed.route,
        payload: parsed.payload,
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

    state.inFlight += 1;
    void handle(state, claimed, requestId).finally(() => {
        state.inFlight -= 1;
        // Anything the concurrency cap made us leave behind is still sitting in
        // the inbox, so look again now that there is room.
        schedule(state);
    });
}

async function handle(state, claimed, requestId) {
    try {
        const request = readRequest(claimed, requestId);
        if (request) {
            try {
                await state.onRequest(request);
            } catch (err) {
                transport.writeAck(requestId, {
                    ok: false,
                    error: err && err.message ? err.message : String(err),
                });
            }
        }
    } finally {
        try {
            fs.rmSync(claimed, { force: true });
        } catch {
            // Deactivation may have removed the inbox already.
        }
    }
}

function scan(state) {
    let entries;
    try {
        entries = fs.readdirSync(state.dir);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (state.stopped) return;
        if (!entry.endsWith(".json")) continue;
        // Leave the rest for the next pass rather than opening an unbounded
        // number of routes at once.
        if (state.inFlight >= MAX_IN_FLIGHT) return;
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

function start(windowId, onRequest) {
    if (typeof onRequest !== "function") throw new TypeError("inbox handler is required");

    let paths;
    try {
        paths = prepare(windowId);
    } catch (err) {
        diag(`porthole inbox unavailable: ${err.message}`);
        return { dispose() {} };
    }

    const state = {
        ...paths,
        onRequest,
        watcher: null,
        poller: null,
        inFlight: 0,
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
