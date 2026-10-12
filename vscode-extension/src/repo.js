// Where we are: the project folder, its git head, and the small path rules
// that go with storing findings about it.
//
// Reviews and tours both save things that point at a repository and want to
// survive being reopened somewhere else, so both need to answer the same
// questions: which folder is the project (as opposed to the session folder we
// were opened alongside), what commit was this written against, and is this
// path allowed.
//
// It lives here rather than in either of them because reviews already imports
// tours - putting it in reviews would make that a cycle.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const vscode = require("vscode");

const { sessionRoot } = require("./session");
const { diag } = require("./log");

const REVISION_LOOKUP_MS = 1500;
const REVISION_OUTPUT_BYTES = 64 * 1024;
const REVISION_CONCURRENCY = 4;

/**
 * The project folder in this window.
 *
 * /cops opens the project and the session folder side by side, so "the first
 * workspace folder" is not good enough - it may well be the session folder.
 * The one that is not underneath session-state is the project.
 */
function projectFolder() {
    const root = sessionRoot().toLowerCase();
    const folder = (vscode.workspace.workspaceFolders || [])
        .map((f) => f.uri.fsPath)
        .find((p) => !p.toLowerCase().startsWith(root));
    return folder || null;
}

/** Reads .git directly, which is cheaper and more predictable than shelling out. */
function gitHead(dir) {
    try {
        const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
        const ref = /^ref:\s*(.+)$/.exec(head);
        if (!ref) return { branch: null, commit: head.slice(0, 7) };
        const branch = ref[1].replace(/^refs\/heads\//, "");
        let commit = null;
        try {
            commit = fs
                .readFileSync(path.join(dir, ".git", ref[1]), "utf8")
                .trim()
                .slice(0, 7);
        } catch {
            commit = null;
        }
        return { branch, commit };
    } catch {
        return { branch: null, commit: null };
    }
}

function normaliseRepo(dir) {
    if (typeof dir !== "string" || !dir.trim()) return null;
    return path.resolve(dir);
}

function revisionBudget(options) {
    if (options.timeoutMs === undefined) return REVISION_LOOKUP_MS;
    const requested = Number(options.timeoutMs);
    return Number.isFinite(requested) && requested > 0
        ? Math.floor(Math.min(requested, REVISION_LOOKUP_MS))
        : 0;
}

/**
 * Git reports its top level as a canonical long path, while the saved locator
 * may be a junction, symlink or 8.3 short name for the same directory.
 */
function canonicalPath(dir) {
    const resolved = normaliseRepo(dir);
    if (!resolved) return null;
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

function sameRepository(left, right) {
    const a = canonicalPath(left);
    const b = canonicalPath(right);
    return Boolean(a && b && (process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b));
}

function unknownRevision(repo) {
    return { repo, branch: null, commit: null };
}

/**
 * Reads one repository revision through Git plumbing.
 *
 * Unlike gitHead(), this handles linked worktrees, packed refs and detached
 * HEADs. It is intentionally asynchronous and bounded because Tour publication
 * and explicit refreshes may call it on the acknowledgement path.
 */
function gitRevision(dir, options = {}) {
    const repo = normaliseRepo(dir);
    if (!repo) return Promise.resolve(unknownRevision(null));

    const timeoutMs = revisionBudget(options);
    if (timeoutMs <= 0) return Promise.resolve(unknownRevision(repo));
    const execute = typeof options.execFile === "function" ? options.execFile : execFile;

    return new Promise((resolve) => {
        let child = null;
        let timer = null;
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(value);
        };

        try {
            child = execute(
                "git",
                ["-C", repo, "-c", "core.quotePath=false", "rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"],
                {
                    encoding: "utf8",
                    windowsHide: true,
                    timeout: timeoutMs,
                    killSignal: "SIGKILL",
                    maxBuffer: REVISION_OUTPUT_BYTES,
                },
                (error, stdout) => {
                    if (error) {
                        finish(unknownRevision(repo));
                        return;
                    }
                    const lines = String(stdout || "").split(/\r?\n/);
                    const commit = /^[0-9a-f]{40,64}$/i.test(lines[1] || "")
                        ? lines[1].toLowerCase()
                        : null;
                    if (!commit || !sameRepository(lines[0], repo)) {
                        finish(unknownRevision(repo));
                        return;
                    }
                    finish({
                        repo,
                        branch: lines[2] && lines[2] !== "HEAD" ? lines[2] : null,
                        commit,
                    });
                },
            );
        } catch (error) {
            diag(`Tour revision lookup could not start: ${error.message}`);
            finish(unknownRevision(repo));
            return;
        }

        if (!settled) {
            timer = setTimeout(() => {
                try {
                    child?.kill("SIGKILL");
                } catch (error) {
                    diag(`Tour revision lookup termination failed: ${error.message}`);
                }
                child?.stdin?.destroy();
                child?.stdout?.destroy();
                child?.stderr?.destroy();
                finish(unknownRevision(repo));
            }, timeoutMs);
        }
    });
}

/**
 * Looks up each distinct repository once with bounded parallelism and one budget.
 */
async function gitRevisions(repositories, options = {}) {
    const timeoutMs = revisionBudget(options);
    const now = typeof options.now === "function" ? options.now : () => performance.now();
    const deadline = now() + timeoutMs;
    const unique = [...new Set(
        (repositories || []).map(normaliseRepo).filter(Boolean),
    )];

    const results = new Map(unique.map((repo) => [repo, unknownRevision(repo)]));
    let cursor = 0;
    const worker = async () => {
        while (cursor < unique.length) {
            const remaining = deadline - now();
            if (remaining <= 0) return;
            const repo = unique[cursor++];
            results.set(repo, await gitRevision(repo, {
                timeoutMs: remaining,
                execFile: options.execFile,
            }));
        }
    };
    await Promise.all(Array.from({ length: Math.min(REVISION_CONCURRENCY, unique.length) }, worker));
    return results;
}

function revisionState(publication, revision) {
    const published = publication?.commit;
    if (!published || !revision?.commit) return "unknown";
    return String(published).toLowerCase() === String(revision.commit).toLowerCase()
        ? "same-revision"
        : "revision-changed";
}

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Stored relative to the repository where possible, so a tour or review still
 * makes sense if the checkout moves.
 */
function storedPath(file, repo) {
    return repo && isInside(repo, file) ? path.relative(repo, file) : file;
}

function absoluteFile(file, repo) {
    if (path.isAbsolute(file)) return file;
    if (repo) return path.join(repo, file);
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    return folder ? path.join(folder.uri.fsPath, file) : file;
}

/** A filename-safe, url-safe, human-readable id. */
function normaliseSlug(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^\w-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

module.exports = {
    projectFolder,
    gitHead,
    gitRevision,
    gitRevisions,
    revisionState,
    sameRepository,
    normaliseRepo,
    isInside,
    storedPath,
    absoluteFile,
    normaliseSlug,
};
