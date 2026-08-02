// Transport between the porthole Copilot CLI extension and this window.
//
// The CLI can only push a URI at VS Code, and a URI query is far too small and
// too fiddly to carry a set of annotations with markdown messages. So anything
// bigger than a couple of numbers travels as a file:
//
//   1. CLI writes   <tmp>/porthole/req/<requestId>.json
//   2. CLI fires    vscode-insiders://lando-00.porthole-companion/annotate?req=<requestId>
//   3. we read the payload and delete it
//   4. we write     <tmp>/porthole/ack/<requestId>.json  ->  { ok, ... }
//   5. CLI polls for the ack, so it learns whether we actually did the work
//
// Step 5 is the important one. Without it a missing companion is
// indistinguishable from a working one, because spawning the launcher always
// "succeeds".

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(os.tmpdir(), "porthole");
const REQ_DIR = path.join(ROOT, "req");
const ACK_DIR = path.join(ROOT, "ack");

const MAX_AGE_MS = 60 * 60 * 1000;

function ensureDirs() {
    fs.mkdirSync(REQ_DIR, { recursive: true });
    fs.mkdirSync(ACK_DIR, { recursive: true });
}

/**
 * Drops files older than an hour.
 *
 * Acks are only ever read by the process that asked for them, and a CLI that
 * timed out never comes back, so without this the directory grows forever.
 */
function sweep() {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const dir of [REQ_DIR, ACK_DIR]) {
        let entries;
        try {
            entries = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const file = path.join(dir, entry);
            try {
                if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
            } catch {
                // Racing with another window's sweep is fine.
            }
        }
    }
}

/** Reads and consumes a request payload. Returns null when there is none. */
function readPayload(requestId) {
    if (!requestId) return null;
    const file = path.join(REQ_DIR, `${safeId(requestId)}.json`);
    try {
        const raw = fs.readFileSync(file, "utf8");
        fs.rmSync(file, { force: true });
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeAck(requestId, body) {
    if (!requestId) return;
    try {
        ensureDirs();
        const file = path.join(ACK_DIR, `${safeId(requestId)}.json`);
        // Write then rename, so a reader never sees a half-written ack.
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...body, at: new Date().toISOString() }), "utf8");
        fs.renameSync(tmp, file);
    } catch {
        // An unwritable temp dir is not worth breaking the command over.
    }
}

/** Request ids come from outside, so never let one escape its directory. */
function safeId(value) {
    return String(value).replace(/[^\w.-]/g, "_").slice(0, 128);
}

/** Parses a URI query string into a plain object. */
function parseQuery(query) {
    const out = {};
    if (!query) return out;
    for (const pair of query.split("&")) {
        if (!pair) continue;
        const idx = pair.indexOf("=");
        const key = idx === -1 ? pair : pair.slice(0, idx);
        const value = idx === -1 ? "" : pair.slice(idx + 1);
        out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
    }
    return out;
}

module.exports = { ensureDirs, sweep, readPayload, writeAck, parseQuery, REQ_DIR, ACK_DIR };
