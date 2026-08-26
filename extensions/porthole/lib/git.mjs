// git helpers.
//
// Every call is allowed to fail and returns null instead of throwing: porthole
// commands must work outside a repository, and a git that is missing, broken or
// simply not applicable is a normal case, not an error.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export function git(args, cwd) {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * --show-toplevel from the cwd returns the *worktree* root, so a linked
 * worktree resolves to itself rather than to the main repository.
 *
 * A resolved root is memoised briefly: this spawns git, and annotating a handful
 * of files called it once per file to resolve the path and again per file to
 * shorten it for the reply - two process spawns per file to be told the same
 * thing, which on Windows is tens of milliseconds each.
 *
 * The entry expires quickly, and a "not a repository" answer is never cached at
 * all. Both `git init` in a fresh directory and `git init` *inside* an existing
 * checkout change the correct answer, and neither should be outlived by a cache
 * that exists only to collapse the calls made within one command.
 */
const ROOT_CACHE_MS = 5000;
const rootCache = new Map();

function cachedRoot(key) {
    const entry = rootCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > ROOT_CACHE_MS) {
        rootCache.delete(key);
        return null;
    }
    return entry.root;
}

export function projectRoot(cwd) {
    const key = resolve(cwd);
    const cached = cachedRoot(key);
    if (cached) return cached;

    const top = git(["rev-parse", "--show-toplevel"], cwd);
    if (!top) return key;

    const root = resolve(top);
    rootCache.set(key, { root, at: Date.now() });
    return root;
}

/** Memoised on the same terms as projectRoot, and for the same reason. */
export function isGitRepo(cwd) {
    if (cachedRoot(resolve(cwd))) return true;
    return git(["rev-parse", "--git-dir"], cwd) !== null;
}

export function currentBranch(cwd) {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export function dirtyCount(cwd) {
    const out = git(["status", "--porcelain"], cwd);
    if (out === null) return null;
    return out.split(/\r?\n/).filter(Boolean).length;
}
