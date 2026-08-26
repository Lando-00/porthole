// Atomic JSON writes for session-owned user data.
//
// Tours and Saved Reviews live in the Copilot session folder, and two VS Code
// windows can legitimately be bound to the same session - opening the session
// folder twice is enough. Both then write the same target path.
//
// Writing to a fixed `<file>.tmp` is not safe there: the second writer truncates
// and rewrites the same temp file while the first is still flushing into it, and
// whichever rename lands last publishes interleaved bytes. The file then fails
// to parse, and a tour or review the user hand-wrote silently disappears from
// the library. Giving every writer its own temp name removes the shared
// mutable, so the rename stays the only contended step - and rename is atomic.

const fs = require("node:fs");
const path = require("node:path");

let counter = 0;

/** A temp path unique to this process and this call. */
function tempPathFor(file) {
    counter += 1;
    return `${file}.${process.pid}.${counter}.tmp`;
}

/**
 * Serialises `value` next to `file`, then renames it into place.
 *
 * Throws on failure, so callers keep reporting what went wrong; the temp file
 * is cleaned up first so a failed write cannot leave litter behind.
 */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = tempPathFor(file);
    try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            // The original error is the one worth reporting.
        }
        throw err;
    }
}

module.exports = { writeJson, tempPathFor };
