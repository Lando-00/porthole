// Keeps revision content, working-file comparisons, and blame details behind one API.

const fs = require("node:fs");
const path = require("node:path");
const { runGit } = require("./gitrun");

const OID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DEFAULT_FILE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_LINE_LIMIT = 20000;
const DEFAULT_BLAME_LINE_LIMIT = 2000;

function limitsFrom(options = {}) {
    options ||= {};
    const limits = options.limits || options;
    return {
        maxFileBytes: limits.maxFileBytes ?? DEFAULT_FILE_LIMIT,
        maxLines: limits.maxLines ?? DEFAULT_LINE_LIMIT,
        maxBlameLines: limits.maxBlameLines ?? DEFAULT_BLAME_LINE_LIMIT,
    };
}

function validOid(oid) {
    return typeof oid === "string" && OID_PATTERN.test(oid);
}

function validRelativePath(relPath) {
    if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\\")) return false;
    if (path.posix.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return false;
    return !relPath.split("/").some((part) => part === "" || part === "." || part === "..");
}

function lexicalRelative(root, file) {
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
    }
    return relative.split(path.sep).join("/");
}

function canonical(target) {
    try {
        return fs.realpathSync.native(target);
    } catch {
        return null;
    }
}

/**
 * Repository-relative POSIX path. Existing paths are canonicalised first, so an
 * 8.3 short name or junction inside or above the repository maps to the path
 * git knows; a lexical mapping is the fallback for paths that no longer exist.
 */
function toRepoRelative(repo, absFile) {
    if (typeof repo !== "string" || typeof absFile !== "string") return null;
    const root = path.resolve(repo);
    const file = path.resolve(absFile);
    const realRoot = canonical(root);
    const realFile = canonical(file);
    if (realRoot && realFile) {
        const real = lexicalRelative(realRoot, realFile);
        if (real) return real;
    }
    return lexicalRelative(root, file);
}

async function hasPath(repo, oid, relPath, options = {}) {
    if (typeof repo !== "string" || !validOid(oid) || !validRelativePath(relPath)) return false;
    const result = await runGit(["cat-file", "-e", `${oid}:${relPath}`], {
        cwd: repo,
        timeoutMs: options.timeoutMs ?? 3000,
        maxStdoutBytes: 1024,
        spawn: options.spawn,
    });
    return result.ok;
}

function absoluteRepoPath(repo, relPath) {
    if (!validRelativePath(relPath)) return null;
    const absolute = path.resolve(repo, ...relPath.split("/"));
    return toRepoRelative(repo, absolute) === relPath ? absolute : null;
}

async function readRevisionFile(repo, oid, relPath, options = {}) {
    if (typeof repo !== "string" || !validOid(oid) || !validRelativePath(relPath)) {
        return { ok: false, reason: "failed", detail: "invalid revision or repository-relative path" };
    }
    const { maxFileBytes } = limitsFrom(options);
    const commit = await runGit(["cat-file", "-e", `${oid}^{commit}`], {
        cwd: repo,
        timeoutMs: options.timeoutMs,
        spawn: options.spawn,
        maxStdoutBytes: 1024,
    });
    if (!commit.ok) {
        return { ok: false, reason: "missing-object", detail: commit.error || commit.stderr };
    }

    const size = await runGit(["cat-file", "-s", `${oid}:${relPath}`], {
        cwd: repo,
        timeoutMs: options.timeoutMs,
        spawn: options.spawn,
        maxStdoutBytes: 1024,
    });
    if (!size.ok) {
        return { ok: false, reason: "missing-path", detail: size.error || size.stderr };
    }
    const byteLength = Number.parseInt(size.stdout.trim(), 10);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        return { ok: false, reason: "failed", detail: "Git returned an invalid blob size" };
    }
    if (byteLength > maxFileBytes) {
        return { ok: false, reason: "too-large", detail: `blob is ${byteLength} bytes` };
    }

    const content = await runGit(["show", `${oid}:${relPath}`], {
        cwd: repo,
        timeoutMs: options.timeoutMs,
        spawn: options.spawn,
        maxStdoutBytes: maxFileBytes,
    });
    if (!content.ok) {
        return {
            ok: false,
            reason: content.reason === "output-limit" ? "too-large" : "failed",
            detail: content.error || content.stderr,
        };
    }
    if (content.stdoutBuffer.subarray(0, 8192).includes(0)) {
        return { ok: false, reason: "binary", detail: "blob contains a NUL byte" };
    }
    return { ok: true, text: content.stdout };
}

async function hasCommit(repo, oid, options = {}) {
    if (typeof repo !== "string" || !validOid(oid)) return false;
    const result = await runGit(["cat-file", "-e", `${oid}^{commit}`], {
        cwd: repo,
        timeoutMs: options.timeoutMs,
        spawn: options.spawn,
        maxStdoutBytes: 1024,
    });
    return result.ok;
}

async function savedMatchesTarget(repo, targetOid, relPath, absFile, options = {}) {
    if (typeof repo !== "string"
        || !validOid(targetOid)
        || !validRelativePath(relPath)
        || toRepoRelative(repo, absFile) === null) {
        return null;
    }
    if (!await hasCommit(repo, targetOid, options)) return null;

    // --path applies the same clean filters Git would use when adding this repository path.
    const saved = await runGit(["hash-object", `--path=${relPath}`, "--", absFile], {
        cwd: repo,
        timeoutMs: options.timeoutMs,
        spawn: options.spawn,
        maxStdoutBytes: 1024,
    });
    if (!saved.ok) return null;

    const target = await runGit(["rev-parse", `${targetOid}:${relPath}`], {
        cwd: repo,
        timeoutMs: options.timeoutMs,
        spawn: options.spawn,
        maxStdoutBytes: 1024,
    });
    if (!target.ok) return false;
    const savedOid = saved.stdout.trim();
    const targetBlobOid = target.stdout.trim();
    if (!validOid(savedOid) || !validOid(targetBlobOid)) return null;
    return savedOid === targetBlobOid;
}

function textLines(text) {
    const normalised = text.replace(/\r\n?/g, "\n");
    if (normalised === "") return [];
    const lines = normalised.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

const MAX_EDIT_DISTANCE = 2000;

/**
 * Line diff as a list of equal/insert/delete edits.
 *
 * Common prefix and suffix are trimmed first, and each Myers frontier snapshot
 * keeps only the diagonals backtracking can read, so memory grows with the
 * square of the edit distance (capped) rather than of the file length. Returns
 * null when the files differ by more than the cap.
 */
function myersEdits(before, after, maxDistance = MAX_EDIT_DISTANCE) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix
        && suffix < after.length - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
        suffix += 1;
    }
    const a = before.slice(prefix, before.length - suffix);
    const b = after.slice(prefix, after.length - suffix);
    const n = a.length;
    const m = b.length;
    const limit = Math.min(n + m, maxDistance);
    const offset = limit + 1;
    const frontier = new Int32Array(2 * limit + 3);
    const trace = [];
    let core = null;

    search:
    for (let d = 0; d <= limit; d += 1) {
        trace.push(frontier.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
                ? frontier[offset + k + 1]
                : frontier[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x += 1;
                y += 1;
            }
            frontier[offset + k] = x;
            if (x >= n && y >= m) {
                core = [];
                let cx = n;
                let cy = m;
                for (let step = d; step >= 0; step -= 1) {
                    const snapshot = trace[step];
                    const at = (diagonal) => snapshot[diagonal + step + 1];
                    const diagonal = cx - cy;
                    const previousK = diagonal === -step || (diagonal !== step && at(diagonal - 1) < at(diagonal + 1))
                        ? diagonal + 1
                        : diagonal - 1;
                    const previousX = step === 0 ? 0 : at(previousK);
                    const previousY = previousX - previousK;
                    while (cx > previousX && cy > previousY) {
                        core.push({ kind: "equal", value: a[cx - 1] });
                        cx -= 1;
                        cy -= 1;
                    }
                    if (step === 0) break;
                    if (cx === previousX) {
                        core.push({ kind: "insert", value: b[cy - 1] });
                        cy -= 1;
                    } else {
                        core.push({ kind: "delete", value: a[cx - 1] });
                        cx -= 1;
                    }
                }
                core.reverse();
                break search;
            }
        }
    }
    if (!core) return null;
    return [
        ...before.slice(0, prefix).map((value) => ({ kind: "equal", value })),
        ...core,
        ...before.slice(before.length - suffix).map((value) => ({ kind: "equal", value })),
    ];
}

function editsToHunks(edits, newLineCount) {
    const hunks = [];
    let oldLine = 1;
    let newLine = 1;
    let index = 0;
    while (index < edits.length) {
        if (edits[index].kind === "equal") {
            oldLine += 1;
            newLine += 1;
            index += 1;
            continue;
        }
        const newStart = newLine;
        let added = 0;
        let removed = 0;
        while (index < edits.length && edits[index].kind !== "equal") {
            if (edits[index].kind === "insert") {
                added += 1;
                newLine += 1;
            } else {
                removed += 1;
                oldLine += 1;
            }
            index += 1;
        }
        if (added > 0) {
            hunks.push({
                start: newStart,
                end: newStart + added - 1,
                kind: removed > 0 ? "modified" : "added",
                removedLines: removed,
            });
        } else {
            const anchor = Math.min(Math.max(1, newStart), Math.max(1, newLineCount));
            hunks.push({
                start: anchor,
                end: anchor,
                kind: "deleted",
                removedLines: removed,
            });
        }
    }
    return hunks;
}

async function readWorkingFile(repo, relPath, options) {
    const absolute = absoluteRepoPath(repo, relPath);
    if (!absolute) return { ok: false, reason: "failed" };
    let stat;
    try {
        stat = await fs.promises.stat(absolute);
    } catch (error) {
        return {
            ok: false,
            reason: error.code === "ENOENT" ? "missing-file" : "failed",
            detail: error.message,
        };
    }
    const { maxFileBytes, maxLines } = limitsFrom(options);
    if (stat.size > maxFileBytes) return { ok: false, reason: "too-large" };
    try {
        const buffer = await fs.promises.readFile(absolute);
        if (buffer.subarray(0, 8192).includes(0)) return { ok: false, reason: "binary" };
        const text = buffer.toString("utf8");
        const lines = textLines(text);
        if (lines.length > maxLines) return { ok: false, reason: "too-large" };
        return { ok: true, text, lines };
    } catch (error) {
        return { ok: false, reason: "failed", detail: error.message };
    }
}

async function changedRanges(repo, comparison, relPath, oldRelPath, options = {}) {
    if (typeof repo !== "string"
        || !comparison
        || !["live", "revisions"].includes(comparison.kind)
        || !validRelativePath(relPath)
        || (oldRelPath !== undefined && oldRelPath !== null && !validRelativePath(oldRelPath))
        || (comparison.base !== null && !validOid(comparison.base))
        || (comparison.target !== null && comparison.target !== undefined && !validOid(comparison.target))) {
        return { ok: false, reason: "failed" };
    }
    const working = await readWorkingFile(repo, relPath, options);
    if (!working.ok) return working;
    if (comparison.base === null) {
        return {
            ok: true,
            hunks: working.lines.length === 0 ? [] : [{
                start: 1,
                end: working.lines.length,
                kind: "added",
                removedLines: 0,
            }],
        };
    }

    const base = await readRevisionFile(repo, comparison.base, oldRelPath || relPath, options);
    if (!base.ok) {
        if (base.reason === "missing-path") {
            return {
                ok: true,
                hunks: working.lines.length === 0 ? [] : [{
                    start: 1,
                    end: working.lines.length,
                    kind: "added",
                    removedLines: 0,
                }],
            };
        }
        return { ok: false, reason: base.reason, detail: base.detail };
    }
    const before = textLines(base.text);
    const { maxLines } = limitsFrom(options);
    if (before.length > maxLines) return { ok: false, reason: "too-large" };
    const edits = myersEdits(before, working.lines);
    if (edits === null) return { ok: false, reason: "too-large" };
    return { ok: true, hunks: editsToHunks(edits, working.lines.length) };
}

function parseBlamePorcelain(text) {
    const lines = String(text).split(/\r?\n/);
    const metadata = new Map();
    const groups = new Map();
    const order = [];
    const headerPattern = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (\d+)(?: (\d+))?$/;

    for (let index = 0; index < lines.length;) {
        const header = headerPattern.exec(lines[index]);
        if (!header) {
            index += 1;
            continue;
        }
        const oid = header[1];
        const originalLine = Number.parseInt(header[2], 10);
        const finalLine = Number.parseInt(header[3], 10);
        index += 1;
        const current = { ...(metadata.get(oid) || {}) };
        while (index < lines.length && !lines[index].startsWith("\t")) {
            const line = lines[index];
            if (headerPattern.test(line)) break;
            const separator = line.indexOf(" ");
            const key = separator < 0 ? line : line.slice(0, separator);
            const value = separator < 0 ? "" : line.slice(separator + 1);
            if (key === "author") current.author = value;
            else if (key === "author-time") current.authorTime = Number.parseInt(value, 10);
            else if (key === "summary") current.summary = value;
            else if (key === "filename") current.filename = value;
            else if (key === "previous") {
                const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (.+)$/.exec(value);
                if (match) current.previous = { oid: match[1], path: match[2] };
            }
            index += 1;
        }
        metadata.set(oid, current);
        if (index >= lines.length || !lines[index].startsWith("\t")) continue;
        index += 1;

        const uncommitted = /^0+$/.test(oid);
        let group = groups.get(oid);
        if (!group) {
            group = {
                oid,
                author: uncommitted ? null : (current.author || null),
                time: uncommitted || !Number.isFinite(current.authorTime)
                    ? null
                    : current.authorTime * 1000,
                summary: uncommitted ? null : (current.summary || null),
                finalLines: [],
                origStart: originalLine,
                previous: current.previous || null,
                filename: current.filename || null,
                uncommitted,
            };
            groups.set(oid, group);
            order.push(oid);
        }
        group.finalLines.push(finalLine);
        group.origStart = Math.min(group.origStart, originalLine);
        if (!uncommitted) {
            group.author ||= current.author || null;
            group.summary ||= current.summary || null;
            if (group.time === null && Number.isFinite(current.authorTime)) {
                group.time = current.authorTime * 1000;
            }
        }
        group.previous ||= current.previous || null;
        group.filename ||= current.filename || null;
    }

    return order.map((oid) => {
        const group = groups.get(oid);
        group.finalLines.sort((left, right) => left - right);
        return group;
    });
}

function uncommittedGroup(relPath, startLine, endLine) {
    return {
        oid: "0".repeat(40),
        author: null,
        time: null,
        summary: null,
        finalLines: Array.from(
            { length: Math.max(0, endLine - startLine + 1) },
            (_, index) => startLine + index,
        ),
        origStart: startLine,
        previous: null,
        filename: relPath,
        uncommitted: true,
    };
}

async function lastChanges(repo, relPath, startLine, endLine, contents, options = {}) {
    const { maxFileBytes, maxBlameLines } = limitsFrom(options);
    if (typeof repo !== "string"
        || !validRelativePath(relPath)
        || !Number.isInteger(startLine)
        || !Number.isInteger(endLine)
        || startLine < 1
        || endLine < startLine) {
        return { ok: false, reason: "failed", detail: "invalid line range or path" };
    }
    if (endLine - startLine + 1 > maxBlameLines) {
        return { ok: false, reason: "too-many-lines" };
    }
    if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > maxFileBytes) {
        return { ok: false, reason: "too-large" };
    }

    const result = await runGit([
        "blame",
        "--porcelain",
        "-L",
        `${startLine},${endLine}`,
        "--contents",
        "-",
        "--",
        relPath,
    ], {
        cwd: repo,
        timeoutMs: options.timeoutMs ?? 5000,
        maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_FILE_LIMIT,
        stdin: contents,
        spawn: options.spawn,
    });
    if (!result.ok) {
        const detail = `${result.stderr}\n${result.error || ""}`;
        if (/not a git repository/i.test(detail)) {
            return { ok: false, reason: "not-repository", detail: result.stderr };
        }
        if (/no such path|cannot stat path|bad revision ['"]?HEAD|no such ref.*HEAD/i.test(detail)) {
            return { ok: true, groups: [uncommittedGroup(relPath, startLine, endLine)] };
        }
        return { ok: false, reason: result.reason || "failed", detail: result.stderr || result.error };
    }
    const groups = parseBlamePorcelain(result.stdout);
    if (groups.length === 0) {
        return { ok: true, groups: [uncommittedGroup(relPath, startLine, endLine)] };
    }
    return { ok: true, groups };
}

module.exports = {
    readRevisionFile,
    hasCommit,
    hasPath,
    savedMatchesTarget,
    changedRanges,
    lastChanges,
    parseBlamePorcelain,
    toRepoRelative,
};
