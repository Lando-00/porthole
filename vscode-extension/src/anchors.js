// Anchoring, and telling the truth about stale findings.
//
// Line numbers rot. A finding saved against line 25 today may point at
// something else entirely after a few edits, and showing an explanation against
// innocent code is the worst thing a tool like this can do - worse than showing
// nothing, because the reader has no way to tell.
//
// So every saved range carries a hash of the exact text it was written about.
// Loading re-checks that hash and reports one of four states, and the caller
// gets the range the code is at *now*, not the one it was at when saved.
//
// Both saved reviews and saved tours have this problem, identically. It lives
// here rather than in either of them because two copies of this logic would
// drift, and a drifting staleness check is a staleness check you cannot trust.

const crypto = require("node:crypto");
const fs = require("node:fs");

/**
 * How far to look for code that has moved.
 *
 * Wide enough to survive a function being added above, narrow enough that a
 * coincidentally identical block elsewhere in a large file is not mistaken for
 * the original.
 */
const SEARCH_WINDOW = 200;

/** How much of the first and last line to keep, for a human-readable record. */
const CONTEXT_CHARS = 200;

function hash(lines) {
    return crypto.createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

function readLines(file) {
    try {
        return fs.readFileSync(file, "utf8").split(/\r?\n/);
    } catch {
        return null;
    }
}

/**
 * A record of what the code said, so a later load can tell whether it still
 * says it.
 *
 * `firstLine` and `lastLine` are not used by the check - the hash is - but they
 * make a stored review or tour legible when someone opens the JSON.
 */
function anchorFor(file, startLine, endLine) {
    const lines = readLines(file);
    if (!lines) return null;
    const slice = lines.slice(startLine - 1, endLine);
    if (slice.length === 0) return null;
    return {
        sha256: hash(slice),
        firstLine: slice[0].trim().slice(0, CONTEXT_CHARS),
        lastLine: slice[slice.length - 1].trim().slice(0, CONTEXT_CHARS),
    };
}

/**
 * Where a saved range actually is now.
 *
 * Returns the resolved range and one of four states:
 *
 *   resolved  the text at the stored range still hashes the same
 *   shifted   the same text was found nearby, so the range is re-pointed
 *   changed   the file is there, the text is not; the stored range is returned
 *             but must be presented as stale
 *   missing   the file has gone
 *
 * Without this the stored line numbers would just be trusted, and whatever now
 * sits at line 25 would be marked up as if the finding were about it.
 *
 * `entry` needs `startLine`, `endLine` and optionally `anchor`.
 */
function resolve(entry, file) {
    const fallback = { startLine: entry.startLine, endLine: entry.endLine };
    const lines = readLines(file);
    if (!lines) return { ...fallback, status: "missing" };

    // Written before anchors existed, or by something that could not read the
    // file. Not trustworthy, so it is reported as stale rather than as good.
    if (!entry.anchor) return { ...fallback, status: "changed" };

    const span = entry.endLine - entry.startLine + 1;
    const at = lines.slice(entry.startLine - 1, entry.endLine);
    if (at.length === span && hash(at) === entry.anchor.sha256) {
        return { ...fallback, status: "resolved" };
    }

    // The code usually has not gone, it has just moved. Looking nearby before
    // giving up means an edit above a finding does not invalidate it.
    const from = Math.max(0, entry.startLine - 1 - SEARCH_WINDOW);
    const to = Math.min(lines.length - span, entry.startLine - 1 + SEARCH_WINDOW);
    for (let i = from; i <= to; i += 1) {
        const candidate = lines.slice(i, i + span);
        if (candidate.length === span && hash(candidate) === entry.anchor.sha256) {
            return { startLine: i + 1, endLine: i + span, status: "shifted" };
        }
    }

    return { ...fallback, status: "changed" };
}

/** An empty tally, so callers do not each invent their own shape. */
function tally() {
    return { resolved: 0, shifted: 0, changed: 0, missing: 0 };
}

module.exports = { SEARCH_WINDOW, anchorFor, resolve, tally, hash, readLines };
