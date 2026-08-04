// This session's address on the porthole transport.
//
// The companion needs to answer "which CLI sessions are alive, and where do I
// put a message for one?" - the mirror of the companion's own heartbeat.
//
// The address is an `endpointId` generated once per process, NOT the session
// id. Two CLI processes can be attached to the same session id, because
// resuming a session is the normal case, and they would otherwise overwrite
// each other's presence file and race for the same outbox.
//
// It also sidesteps a bootstrap problem: `ctx.sessionId` only exists inside a
// command handler, so at load time the extension may not know its session id
// at all. The endpoint is always known, so the reverse channel works from the
// moment the extension loads rather than from the first porthole command.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { copilotHome } from "./config.mjs";

const ENDPOINT_ID = randomBytes(8).toString("hex");
const STARTED_AT = new Date().toISOString();

let cached = { sessionId: null, sessionName: null, cwd: process.cwd(), projectRoot: null };
let version = "0.0.0";
let registered = false;

export function endpointId() {
    return ENDPOINT_ID;
}

export function portholeHome() {
    return join(copilotHome(), "porthole");
}

function presencePath() {
    return join(portholeHome(), `cli-${ENDPOINT_ID}.json`);
}

/**
 * The session id, if it can be worked out yet.
 *
 * `session.workspacePath` is the SDK's own answer and its basename is the id.
 * A command handler's `ctx.sessionId` is exact, so it wins when available.
 */
function resolveSessionId(session, ctx) {
    if (ctx?.sessionId) return ctx.sessionId;
    const dir = session?.workspacePath;
    if (typeof dir === "string" && dir) return basename(dir);
    return null;
}

/**
 * Builds the presence record without writing it.
 *
 * Used by the doctor, which should report on the world rather than change it.
 */
export function describe(session, ctx = null) {
    return {
        endpointId: ENDPOINT_ID,
        sessionId: resolveSessionId(session, ctx) || cached.sessionId,
        sessionName: cached.sessionName,
        pid: process.pid,
        cwd: process.cwd(),
        projectRoot: cached.projectRoot,
        tmpdir: tmpdir(),
        copilotHome: copilotHome(),
        version,
        startedAt: STARTED_AT,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Writes or refreshes the presence file.
 *
 * Called at load and again on every command, so `sessionId` fills in as soon
 * as anything reveals it.
 */
export function touch(session, ctx = null, extra = {}) {
    const sessionId = resolveSessionId(session, ctx) || cached.sessionId;
    cached = {
        sessionId,
        sessionName: extra.sessionName ?? cached.sessionName,
        cwd: process.cwd(),
        projectRoot: extra.projectRoot ?? cached.projectRoot,
    };

    const record = describe(session, ctx);

    try {
        mkdirSync(portholeHome(), { recursive: true, mode: 0o700 });
        const file = presencePath();
        // Write then rename, so a reader never sees a half-written record.
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
        renameSync(tmp, file);
    } catch {
        // An unwritable home directory is not worth breaking a command over.
    }

    return record;
}

export function remove() {
    try {
        rmSync(presencePath(), { force: true });
    } catch {
        // ignore
    }
}

/**
 * Live CLI endpoints, newest first, pruning any whose process is gone.
 *
 * Mirrors how the CLI already prunes companion heartbeats, so a crashed
 * session cannot leave a lie behind.
 */
/**
 * Whether a process is still running.
 *
 * ESRCH means it is gone; EPERM means it exists but belongs to someone we
 * cannot signal, which happens routinely when one side runs elevated and the
 * other does not. Treating EPERM as dead would delete a live session's file.
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

export function findEndpoints() {
    const dir = portholeHome();
    if (!existsSync(dir)) return [];

    let entries = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    const found = [];
    for (const entry of entries) {
        if (!entry.startsWith("cli-") || !entry.endsWith(".json")) continue;
        const file = join(dir, entry);
        let info;
        try {
            info = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            continue;
        }
        if (!info.pid || !info.endpointId) continue;
        if (info.pid !== process.pid && !isAlive(info.pid)) {
            rmSync(file, { force: true }); // that session is gone
            // Its outbox can never be read again - the endpoint id was unique
            // to that process - so anything left in it would keep the user's
            // selected source code in their home directory forever.
            discard(join(dir, "outbox", info.endpointId));
            continue;
        }
        found.push({ ...info, file });
    }

    sweepAcks();
    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function discard(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // racing another process's prune is fine
    }
}

/**
 * Drops acks nobody can still be waiting for.
 *
 * Senders give up after seconds, so anything an hour old is litter.
 */
function sweepAcks() {
    const dir = join(portholeHome(), "outbox-ack");
    let entries = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
        const file = join(dir, entry);
        try {
            if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
        } catch {
            // already gone
        }
    }
}

/**
 * Starts publishing presence.
 *
 * The process-exit handlers are best effort: a killed process cannot clean up
 * after itself, which is exactly why readers probe the pid rather than
 * trusting the file's existence.
 */
export function start(session, options = {}) {
    version = options.version || version;
    touch(session, null, options);

    if (!registered) {
        registered = true;
        for (const signal of ["exit", "SIGINT", "SIGTERM"]) {
            process.once(signal, () => remove());
        }
    }
    return ENDPOINT_ID;
}
