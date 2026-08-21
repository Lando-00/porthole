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

let active = null;

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

async function consume(state, entry) {
    const requestId = entryRequestId(entry);
    if (!requestId) {
        discardInvalidEntry(state.dir, entry);
        return;
    }

    let source;
    let claimed;
    try {
        source = childPath(state.dir, entry);
        claimed = childPath(state.processing, entry);
        fs.renameSync(source, claimed);
    } catch {
        // Another scan or process claimed it, or the file disappeared.
        return;
    }

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

async function scan(state) {
    let entries;
    try {
        entries = fs.readdirSync(state.dir);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (state.stopped) return;
        if (!entry.endsWith(".json")) continue;
        await consume(state, entry);
    }
}

function schedule(state) {
    if (active !== state || state.stopped) return;
    state.scanRequested = true;
    if (state.scanning) return;

    state.scanning = true;
    void (async () => {
        try {
            while (state.scanRequested && !state.stopped) {
                state.scanRequested = false;
                await scan(state);
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
    if (active) return { dispose: stop };
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
        scanRequested: false,
        scanning: false,
        stopped: false,
    };
    active = state;

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
                diag(`porthole inbox watcher failed: ${err.message}`);
            });
        }
    } catch (err) {
        diag(`porthole inbox watcher unavailable: ${err.message}`);
    }

    // Handles requests written before the extension host activated.
    schedule(state);
    return { dispose: () => stop(state) };
}

function stop(expected = null) {
    const state = expected || active;
    if (!state || (active && state !== active)) return;

    state.stopped = true;
    if (active === state) active = null;
    try {
        if (state.watcher) state.watcher.close();
    } catch {
        // Already closed.
    }

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
