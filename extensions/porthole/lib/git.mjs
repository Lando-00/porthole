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
 */
export function projectRoot(cwd) {
    const top = git(["rev-parse", "--show-toplevel"], cwd);
    return top ? resolve(top) : resolve(cwd);
}

export function isGitRepo(cwd) {
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
